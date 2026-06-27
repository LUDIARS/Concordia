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
import { DEFAULT_PREDICATES, isEditTool, type HarnessAction } from "../harness/predicates.js";
import { classifyPromptIntent, type IntentHarnessRule } from "../harness/prompt-intent.js";
import type { RunClaudeFn } from "../subsidiary/guard.js";

const ActionSchema = z.object({
  tool: z.string().max(64),
  command: z.string().max(20000).optional(),
  filePath: z.string().max(4096).optional(),
  cwd: z.string().max(4096).optional(),
  project: z.string().max(256).optional(),
  branch: z.string().max(256).optional(),
  editedRepos: z.array(z.string().max(4096)).max(200).optional(),
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

/** per-prompt 意図判定に使う Sonnet モデル (env 上書き可)。 */
const INTENT_MODEL = process.env.CONCORDIA_HARNESS_INTENT_MODEL || "sonnet";

export interface HarnessSessionApiDeps {
  audit: HarnessAuditRepo;
  /** 自然文ハーネスルール (Sonnet guard と共有)。 context 供給で列挙する。 */
  rules: HarnessRulesRepo;
  /**
   * per-prompt 意図判定層 (POST /intent) 用の Sonnet runner。 未注入なら /intent は無効
   * (opt-in)。 per-action 決定的ゲートは runClaude 不要で常時動く。
   */
  runClaude?: RunClaudeFn;
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

  app.get("/health", (c) => c.json({ ok: true, predicates: DEFAULT_PREDICATES.length }));

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
    if (repo && isEditTool(action.tool) && !editedRepos.includes(repo)) editedRepos.push(repo);

    const verdict = evaluateAction({ ...action, editedRepos } as HarnessAction);
    const event: HarnessAuditEvent = verdict.decision === "deny" ? "block" : "gate";
    // 当たった hit の代表 rule (最悪 decision のもの)。
    const lead = verdict.hits.find((h) => h.decision === verdict.decision);

    const rec = recordSafe(deps.audit, {
      session_id, project: action.project, hook: hook ?? "gate", event,
      tool: action.tool, action: action.command ?? action.filePath ?? "", repo,
      rule: lead?.rule ?? "", decision: verdict.decision as HarnessAuditDecision,
      reason: verdict.reason, detail: { hits: verdict.hits, branch: action.branch }, ms: Date.now() - t0,
    });

    return c.json({
      decision: verdict.decision,
      blocked: verdict.blocked,
      reason: verdict.reason,
      hits: verdict.hits,
      audit_ok: rec.ok,
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

    const rules = deps.rules.list().map((r) => ({ kind: r.kind, title: r.title, description: r.description }));
    const gates = DEFAULT_PREDICATES.map((p) => p.name);

    recordSafe(deps.audit, {
      session_id, project, hook: "supply", event: "inject", decision: "allow",
      action: (task ?? "").slice(0, 200), reason: `rules:${rules.length} gates:${gates.length}`, ms: Date.now() - t0,
    });

    return c.json({ rules, gates });
  });

  // per-prompt 意図判定 (Sonnet)。 着手前に自然文ルールへの抵触を助言する advisory 層。
  // runClaude 未注入なら opt-in 無効として enabled:false を返す (per-action ゲートは別途常時稼働)。
  app.post("/intent", async (c) => {
    const t0 = Date.now();
    const body = await c.req.json().catch(() => null);
    const parsed = IntentSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const { prompt, project, branch, session_id } = parsed.data;

    if (!deps.runClaude) return c.json({ enabled: false, reason: "intent 判定は未配線 (runClaude 未注入)" });

    const rules: IntentHarnessRule[] = deps.rules.list().map((r) => ({ kind: r.kind, title: r.title, description: r.description }));
    const gates = DEFAULT_PREDICATES.map((p) => p.name);
    const { verdict, raw } = await classifyPromptIntent(
      { prompt, project, branch, rules, gates },
      { model: INTENT_MODEL, runClaude: deps.runClaude },
    );

    const rec = recordSafe(deps.audit, {
      session_id, project, hook: "intent", event: "start_prompt",
      action: prompt.slice(0, 200), rule: verdict.concerns[0] ?? "",
      decision: verdict.decision as HarnessAuditDecision,
      reason: verdict.advice || verdict.intent,
      detail: { risk: verdict.risk, concerns: verdict.concerns, intent: verdict.intent, raw: raw.slice(0, 2000) },
      ms: Date.now() - t0,
    });

    return c.json({ enabled: true, ...verdict, audit_ok: rec.ok, ...(rec.error ? { audit_error: rec.error } : {}) });
  });

  // 監査ログ取得 (確認経路)。
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

  // hook が override (warn を理由添えて続行) を記録する経路。
  app.post("/override", async (c) => {
    const body = await c.req.json().catch(() => null);
    const session_id = typeof body?.session_id === "string" ? body.session_id : undefined;
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 2000) : "";
    const rec = recordSafe(deps.audit, {
      session_id, hook: "gate", event: "override", decision: "warn",
      tool: typeof body?.tool === "string" ? body.tool : "", reason,
    });
    return c.json({ ok: rec.ok, ...(rec.error ? { audit_error: rec.error } : {}) });
  });

  return app;
}
