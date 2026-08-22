/**
 * /v1/harness — ローカルセッションのハーネス強制ゲート API。 loopback 信頼境界 (token 不要)。
 *
 * thin hook (.claude/hooks/harness-*.mjs) がここを叩く:
 *  - POST /gate    : 操作 1 件を決定的述語で判定 → 監査記録 → verdict 返却 (deny で hook がブロック)。
 *  - POST /context : 着手前にハーネスルールを供給 (supply / inject)。
 *  - GET  /audit   : 監査ログ取得 (「強制が効いたか」の確認経路)。
 *  - GET  /health  : 起動確認 (hook の fail-closed プローブ用)。
 *
 * 子会社 gate と同じ思想だが per-action は LLM 不使用 (latency)。 設計: harness/session-gate.ts。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { HarnessAuditRepo, HarnessAuditEvent, HarnessAuditDecision } from "../db/harness-audit-repo.js";
import type { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { evaluateAction } from "../harness/session-gate.js";
import { DEFAULT_PREDICATES, isEditTool, withMainPushAllowlist, type HarnessAction } from "../harness/predicates.js";
import { makeStrongModelImplPredicate } from "../harness/strong-model-gate.js";
import { notifyUserDecision } from "../taskflow/notify.js";
import type { IntentHarnessRule, PromptIntentContext } from "../harness/prompt-intent.js";
import {
  HARNESS_BLACKBOX_DOMAINS,
  type HarnessBlackboxMeta,
  type HarnessBlackboxService,
} from "../harness/blackbox-engine.js";
import {
  analyzePromptWithClaudeModel,
  analyzePromptWithLocalLlm,
  heuristicPromptAnalysis,
} from "../harness/local-prompt-analyzer.js";
import { collectPromptResearch } from "../harness/prompt-research.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import { createChildLogger } from "../shared/logger.js";
import { vgWrite, type VgLevel } from "../shared/vestigium.js";

const hlog = createChildLogger("harness");

/**
 * ハーネスイベントを pino (dev コンソール/ファイル) と Vestigium (横断 JSONL) の両方へ出す。
 * ctx はメタデータのみ — コマンド/プロンプトの生データや秘密は入れない (Vestigium redact ルール)。
 */
function emit(level: VgLevel, msg: string, ctx: Record<string, unknown>): void {
  hlog[level](ctx, msg);
  vgWrite(level, msg, ctx);
}

const ActionSchema = z.object({
  tool: z.string().max(64),
  command: z.string().max(20000).optional(),
  filePath: z.string().max(4096).optional(),
  cwd: z.string().max(4096).optional(),
  project: z.string().max(256).optional(),
  branch: z.string().max(256).optional(),
  editedRepos: z.array(z.string().max(4096)).max(200).optional(),
  isWorktree: z.boolean().optional(),
});

const GateSchema = z.object({
  action: ActionSchema,
  session_id: z.string().max(128).optional(),
  hook: z.string().max(64).optional(),
});

const ContextSchema = z.object({
  task: z.string().max(8000).optional(),
  project: z.string().max(256).optional(),
  session_id: z.string().max(128).optional(),
});

const IntentSchema = z.object({
  prompt: z.string().min(1).max(20000),
  project: z.string().max(256).optional(),
  branch: z.string().max(256).optional(),
  session_id: z.string().max(128).optional(),
});

const BlackboxVerdictSchema = z.object({
  decision_id: z.number().int().positive(),
  verdict: z.enum(["ok", "ng"]),
});

/** per-prompt 意図判定に使う Sonnet モデル (env 上書き可)。 */
const INTENT_MODEL = process.env.CONCORDIA_HARNESS_INTENT_MODEL || "sonnet";

function promptAnalyzerMode(): string {
  return (process.env.CONCORDIA_PROMPT_ANALYZER || "local").toLowerCase();
}

function promptResearchEnabled(): boolean {
  return process.env.CONCORDIA_PROMPT_RESEARCH === "1";
}

interface HarnessSessionContext {
  model?: string;
  implUnlocked?: boolean;
  isWorktree?: boolean;
  contractComplete?: boolean;
  planApproved?: boolean;
  contractMode?: "plan" | "vibes";
  contractScopeDirs?: string[];
  vibesClaimActive?: boolean;
  teamId?: string | null;
  teamTestPolicy?: "confirm-queue" | "custos-unity";
  teamWorktreePolicy?: "allowed" | "repo-root-only";
  teamVisibility?: "public" | "private";
  readOnlyInquiry?: boolean;
  inquiryCaseId?: string;
  inquiryApiBaseUrl?: string;
  inquiryReadRoot?: string;
  inquiryAllowedRunIds?: string[];
}

export interface HarnessSessionApiDeps {
  audit: HarnessAuditRepo;
  /** 自然文ハーネスルール (Sonnet guard と共有)。 context 供給で列挙する。 */
  rules: HarnessRulesRepo;
  /**
   * per-prompt 意図判定層 (POST /intent) 用の Sonnet runner。 未注入なら /intent は無効
   * (opt-in)。 per-action 決定的ゲートは runClaude 不要で常時動く。
   */
  runClaude?: RunClaudeFn;
  /** Resident Lapilli blackbox engine for harness decisions and review ledger. */
  blackbox?: HarnessBlackboxService;
  /**
   * session の作業対象スコープを解決する (outside-scope 述語用)。 明示 `target_project` →
   * 無ければ登録時 `repo_path` の順で返す。 未注入 / 不明なら null (= スコープ強制なし)。
   * gate ハンドラがこれを {@link HarnessAction.targetProject} に注入する。
   */
  sessionScope?: (sessionId: string) => string | null;
  sessionContext?: (sessionId: string) => HarnessSessionContext | null;
  strongImplModels?: () => string[];
  /**
   * main 直 push を許可するリポ (ディレクトリ名 or 絶対パス)。 未注入なら例外なし =
   * 従来どおり全リポで no-main-push が deny する。
   */
  mainPushAllowlist?: () => string[];
  mentionUserId?: () => string | null;
  onVibesFileLimit?: (sessionId: string) => void;
}

function compactBlackboxMeta(meta: HarnessBlackboxMeta | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  return {
    domain: meta.domain,
    decision_id: meta.decision_id,
    engine_source: meta.engine_source,
    status: meta.status,
    rule_id: meta.rule_id,
    confidence: meta.confidence,
  };
}

/**
 * 監査記録のラッパ。 書き込み失敗は握りつぶさず stderr に surface し、 失敗フラグを返す
 * ([[feedback_no_error_swallow]])。 証跡が落ちることは強制の保証が崩れることなので必ず気づかせる。
 */
function recordSafe(
  audit: HarnessAuditRepo,
  input: Parameters<HarnessAuditRepo["record"]>[0],
): { ok: boolean; error?: string } {
  try {
    audit.record(input);
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[harness/audit] 監査記録に失敗 (event=${input.event} decision=${input.decision}): ${msg}`);
    return { ok: false, error: msg };
  }
}

export function harnessSessionRouter(deps: HarnessSessionApiDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({
    ok: true,
    predicates: DEFAULT_PREDICATES.length,
    blackbox: deps.blackbox
      ? { enabled: true, domains: HARNESS_BLACKBOX_DOMAINS }
      : { enabled: false },
  }));

  // 操作 1 件を判定する。 deny は hook が操作をブロックする。
  app.post("/gate", async (c) => {
    const t0 = Date.now();
    const body = await c.req.json().catch(() => null);
    const parsed = GateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const { action, session_id, hook } = parsed.data;

    // editedRepos はサーバ側で蓄積する (監査ログ = 状態源)。 hook は per-action の cwd/branch を
    // 送るだけの薄い腕に保ち、 セッション横断の集合管理は Concordia が持つ。 過去の編集ツール
    // イベントが触ったリポ root の集合に、 今回が編集ツールなら現在 repo を足して maxReposWarn に渡す。
    const repo = action.cwd ?? "";
    const editedRepos = [...deps.audit.distinctEditedRepos(session_id ?? "")];
    const editedFiles = session_id ? deps.audit.recent({ session_id, limit: 1000 })
      .filter((row) => isEditTool(row.tool) && row.action)
      .map((row) => row.action) : [];
    if (isEditTool(action.tool) && action.filePath && !editedFiles.includes(action.filePath)) editedFiles.push(action.filePath);
    if (repo && isEditTool(action.tool) && !editedRepos.includes(repo)) editedRepos.push(repo);

    // 作業対象スコープ (outside-scope 述語用)。 hook が action.project を明示していればそれを
    // 優先し、 無ければ session の target_project / repo_path を Concordia 側で解決する
    // (hook は薄い腕に保つ = セッション状態源は Concordia)。
    const targetProject = action.project ?? (session_id ? deps.sessionScope?.(session_id) ?? undefined : undefined);

    const sessionContext = session_id ? deps.sessionContext?.(session_id) ?? null : null;
    const enrichedAction: HarnessAction = {
      ...action,
      editedRepos,
      targetProject,
      sessionModel: sessionContext?.model,
      implUnlocked: sessionContext?.implUnlocked,
      isWorktree: action.isWorktree ?? sessionContext?.isWorktree,
      contractComplete: sessionContext?.contractComplete,
      planApproved: sessionContext?.planApproved,
      contractMode: sessionContext?.contractMode,
      contractScopeDirs: sessionContext?.contractScopeDirs,
      vibesClaimActive: sessionContext?.vibesClaimActive,
      teamTestPolicy: sessionContext?.teamTestPolicy,
      teamWorktreePolicy: sessionContext?.teamWorktreePolicy,
      teamVisibility: sessionContext?.teamVisibility,
      readOnlyInquiry: sessionContext?.readOnlyInquiry,
      inquiryCaseId: sessionContext?.inquiryCaseId,
      inquiryApiBaseUrl: sessionContext?.inquiryApiBaseUrl,
      inquiryReadRoot: sessionContext?.inquiryReadRoot,
      inquiryAllowedRunIds: sessionContext?.inquiryAllowedRunIds,
      editedFiles,
    };
    // 設定は都度解決する (WebUI / env の変更を再起動なしで反映)。
    const mainPushAllowlist = deps.mainPushAllowlist?.() ?? [];
    const basePredicates = withMainPushAllowlist(mainPushAllowlist, DEFAULT_PREDICATES);
    const predicates = deps.strongImplModels
      ? [...basePredicates, makeStrongModelImplPredicate(deps.strongImplModels())]
      : basePredicates;
    const deterministic = evaluateAction(enrichedAction, predicates);
    let verdict = deterministic;
    let blackbox: Awaited<ReturnType<HarnessBlackboxService["decideGate"]>> | undefined;
    let blackboxError: string | undefined;
    if (deps.blackbox) {
      try {
        blackbox = await deps.blackbox.decideGate({
          action: enrichedAction,
          editedRepos,
          verdict: deterministic,
          session_id,
          hook: hook ?? "gate",
          mainPushAllowlist,
        });
        // 決定的 deny は強制境界の正本。学習ルールが誤って allow/warn を返しても
        // 問診 read-only や main push 禁止を降格させない。
        verdict = deterministic.decision === "deny" ? deterministic : blackbox.verdict;
      } catch (e) {
        blackboxError = (e as Error).message;
        hlog.warn({ err: blackboxError, session_id, hook: hook ?? "gate" }, "harness blackbox gate failed");
      }
    }
    const event: HarnessAuditEvent = verdict.decision === "deny" ? "block" : "gate";
    // 当たった hit の代表 rule (最悪 decision のもの)。
    const lead = verdict.hits.find((h) => h.decision === verdict.decision);
    if (lead?.rule === "vibes-file-limit" && session_id) deps.onVibesFileLimit?.(session_id);
    if (lead?.rule === "strong-model-impl" && session_id) {
      notifyUserDecision({
        kind: "impl-unlock",
        targetSessionId: session_id,
        mentionUserId: deps.mentionUserId?.(),
        text: "強推論モデルによる直接実装をブロックしました。delegation に委託するか、承認後に impl-unlock してください。",
      });
    }

    const rec = recordSafe(deps.audit, {
      session_id, project: action.project, hook: hook ?? "gate", event,
      tool: action.tool, action: action.command ?? action.filePath ?? "", repo,
      rule: lead?.rule ?? "", decision: verdict.decision as HarnessAuditDecision,
      reason: verdict.reason,
      detail: {
        hits: verdict.hits,
        branch: action.branch,
        deterministic,
        blackbox: compactBlackboxMeta(blackbox?.meta),
        ...(blackboxError ? { blackbox_error: blackboxError } : {}),
      },
      ms: Date.now() - t0,
    });

    const gateLevel: VgLevel = verdict.decision === "deny" ? "warn" : verdict.decision === "warn" ? "info" : "debug";
    emit(gateLevel, `harness gate ${verdict.decision}${lead?.rule ? `: ${lead.rule}` : ""}`, {
      session_id, hook: hook ?? "gate", tool: action.tool, repo, branch: action.branch,
      decision: verdict.decision, rules: verdict.hits.map((h) => h.rule), editedRepos: editedRepos.length,
      audit_ok: rec.ok,
      blackbox_source: blackbox?.meta.engine_source,
      blackbox_decision_id: blackbox?.meta.decision_id,
      ms: Date.now() - t0,
    });

    return c.json({
      decision: verdict.decision,
      blocked: verdict.blocked,
      reason: verdict.reason,
      hits: verdict.hits,
      audit_ok: rec.ok,
      ...(blackbox ? { blackbox: blackbox.meta } : {}),
      ...(blackboxError ? { blackbox_error: blackboxError } : {}),
      ...(rec.error ? { audit_error: rec.error } : {}),
    });
  });

  // 着手前のハーネスルール供給 (supply / inject)。 有効な block/allow ルールと決定的述語を返す。
  app.post("/context", async (c) => {
    const t0 = Date.now();
    const body = await c.req.json().catch(() => null);
    const parsed = ContextSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const { task, project, session_id } = parsed.data;

    const teamId = session_id ? deps.sessionContext?.(session_id)?.teamId ?? null : null;
    const rules = deps.rules.listForTeam(teamId).map((r) => ({ kind: r.kind, title: r.title, description: r.description }));
    const gates = DEFAULT_PREDICATES.map((p) => p.name);

    recordSafe(deps.audit, {
      session_id, project, hook: "supply", event: "inject", decision: "allow",
      action: (task ?? "").slice(0, 200), reason: `rules:${rules.length} gates:${gates.length}`, ms: Date.now() - t0,
    });

    emit("info", "harness supply", { session_id, project, rules: rules.length, gates: gates.length, ms: Date.now() - t0 });

    return c.json({
      rules,
      gates,
      ...(deps.blackbox ? { blackbox: deps.blackbox.snapshot(HARNESS_BLACKBOX_DOMAINS.gate, 25).stats } : {}),
    });
  });

  // per-prompt 意図判定 (Sonnet)。 着手前に自然文ルールへの抵触を助言する advisory 層。
  // runClaude 未注入なら opt-in 無効として enabled:false を返す (per-action ゲートは別途常時稼働)。
  app.post("/intent", async (c) => {
    const t0 = Date.now();
    const body = await c.req.json().catch(() => null);
    const parsed = IntentSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const { prompt, project, branch, session_id } = parsed.data;

    const teamId = session_id ? deps.sessionContext?.(session_id)?.teamId ?? null : null;
    const rules: IntentHarnessRule[] = deps.rules.listForTeam(teamId).map((r) => ({ kind: r.kind, title: r.title, description: r.description }));
    const gates = DEFAULT_PREDICATES.map((p) => p.name);
    const intentContext: PromptIntentContext = { prompt, project, branch, rules, gates };
    const mode = promptAnalyzerMode();
    const analyzed = mode === "off"
      ? heuristicPromptAnalysis(intentContext)
      : (mode === "haiku" || mode === "claude" || mode === "sonnet") && deps.runClaude
        ? await analyzePromptWithClaudeModel(intentContext, deps.runClaude, { model: mode === "haiku" ? "haiku" : INTENT_MODEL })
        : await analyzePromptWithLocalLlm(intentContext);
    const { raw, analysis, source } = analyzed;
    let verdict = analyzed.verdict;
    let blackbox: Awaited<ReturnType<HarnessBlackboxService["decideIntent"]>> | undefined;
    let blackboxError: string | undefined;
    if (deps.blackbox) {
      try {
        blackbox = await deps.blackbox.decideIntent({ prompt, project, branch, source, verdict, analysis });
        verdict = blackbox.verdict;
      } catch (e) {
        blackboxError = (e as Error).message;
        hlog.warn({ err: blackboxError, session_id, project }, "harness blackbox intent failed");
      }
    }
    const research = promptResearchEnabled()
      ? await collectPromptResearch(analysis, { prompt, project })
      : { enabled: false, threshold: 0, query_terms: [], projects: [], anatomia: [], thaleia: [] };

    const rec = recordSafe(deps.audit, {
      session_id, project, hook: "intent", event: "start_prompt",
      action: prompt.slice(0, 200), rule: verdict.concerns[0] ?? "",
      decision: verdict.decision as HarnessAuditDecision,
      reason: verdict.advice || verdict.intent,
      detail: {
        risk: verdict.risk,
        concerns: verdict.concerns,
        intent: verdict.intent,
        source,
        search_tags: analysis.search_tags,
        target_services: analysis.target_services,
        safety: analysis.safety,
        research,
        blackbox: compactBlackboxMeta(blackbox?.meta),
        ...(blackboxError ? { blackbox_error: blackboxError } : {}),
        raw: raw.slice(0, 2000),
      },
      ms: Date.now() - t0,
    });

    const intentLevel: VgLevel = verdict.decision === "warn" ? "warn" : "info";
    emit(intentLevel, `harness intent ${verdict.decision} (risk=${verdict.risk})`, {
      session_id, project, branch, decision: verdict.decision, risk: verdict.risk,
      concerns: verdict.concerns, intent: verdict.intent.slice(0, 120), source, search_tags: analysis.search_tags, target_services: analysis.target_services, safety: analysis.safety.level, research_enabled: research.enabled,
      blackbox_source: blackbox?.meta.engine_source,
      blackbox_decision_id: blackbox?.meta.decision_id,
      ms: Date.now() - t0,
    });

    return c.json({
      enabled: true,
      source,
      ...verdict,
      search_tags: analysis.search_tags,
      target_services: analysis.target_services,
      safety: analysis.safety,
      research,
      audit_ok: rec.ok,
      ...(blackbox ? { blackbox: blackbox.meta } : {}),
      ...(blackboxError ? { blackbox_error: blackboxError } : {}),
      ...(rec.error ? { audit_error: rec.error } : {}),
    });
  });

  app.post("/blackbox/verdict", async (c) => {
    if (!deps.blackbox) return c.json({ enabled: false, error: "blackbox_disabled" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = BlackboxVerdictSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const out = deps.blackbox.recordVerdict(parsed.data.decision_id, parsed.data.verdict);
    return c.json({ ok: out.ok, rule_updated: out.ruleUpdated ?? null });
  });

  app.get("/audit", (c) => {
    const session_id = c.req.query("session_id") || undefined;
    const decisionRaw = c.req.query("decision");
    const eventRaw = c.req.query("event");
    const limitRaw = Number(c.req.query("limit") ?? 100);
    const decision = (["allow", "deny", "warn"] as const).includes(decisionRaw as HarnessAuditDecision)
      ? (decisionRaw as HarnessAuditDecision) : undefined;
    const event = (["inject", "gate", "block", "start_prompt", "override"] as const).includes(eventRaw as HarnessAuditEvent)
      ? (eventRaw as HarnessAuditEvent) : undefined;
    const limit = Math.max(1, Math.min(1000, isFinite(limitRaw) ? limitRaw : 100));
    return c.json({
      audit: deps.audit.recent({ session_id, decision, event, limit }),
      summary: deps.audit.summary(),
    });
  });

  return app;
}
