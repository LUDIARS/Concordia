/**
 * 子会社ゲート。 出張先からの作業指示 1 件を:
 *   1. ロック済みユーザなら即 deny
 *   2. Sonnet ガード (guard.ts) で判定
 *   3. 監査記録 (subsidiary_requests)
 *   4. deny かつ lock 推奨ならユーザをロック
 *   5. allow なら専用 delegation を起動 (subsidiary_id タグ付き)
 * まで一気に処理し、 出張先へ返す文面 (replyText) を返す。
 *
 * Bot (Discord/Slack) はこのゲートを呼ぶだけで、 ガードの中身を知らない (SRP)。
 */

import type { SubsidiaryRepo, SubsidiaryRow } from "../db/subsidiary-repo.js";
import type { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import type { DelegationProvider, DelegationRepo } from "../db/delegation-repo.js";
import type { DelegationService } from "../delegation/service.js";
import type { SubsidiaryBudgetStatus } from "./budget.js";
import { runGuard, type GuardVerdict, type RunClaudeFn } from "./guard.js";
import { buildSubsidiaryIntentInjection } from "./intent-inject.js";

export interface SubsidiaryGateDeps {
  subsidiaryRepo: SubsidiaryRepo;
  harnessRepo: HarnessRulesRepo;
  delegationRepo: DelegationRepo;
  delegationService: DelegationService;
  runClaude: RunClaudeFn;
  /** 子会社の日次トークン予算判定 (省略時は予算チェックを行わない = 無制限)。 */
  budget?: { status: (sub: { id: string; daily_token_budget: number }) => SubsidiaryBudgetStatus };
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface GateInput {
  subsidiary: SubsidiaryRow;
  platform: "discord" | "slack";
  userId: string;
  userLabel: string;
  instruction: string;
}

export type GateOutcome = "locked" | "denied" | "allowed" | "spawn_failed" | "budget_exceeded";

export interface GateResult {
  outcome: GateOutcome;
  reason: string;
  verdict?: GuardVerdict;
  runId?: string | null;
  callName?: string | null;
  /** 出張先へ返す日本語文面。 */
  replyText: string;
}

const GUARD_TIMEOUT_MS = Number(process.env.CONCORDIA_SUBSIDIARY_GUARD_TIMEOUT_MS ?? "60000") || 60000;

/** トークン数を人が読みやすい桁 (1,234k / 1,234) に整形する。 */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000).toLocaleString("en-US")}k`;
  return n.toLocaleString("en-US");
}

export async function processSubsidiaryRequest(deps: SubsidiaryGateDeps, input: GateInput): Promise<GateResult> {
  const { subsidiary: sub, platform, userId, userLabel, instruction } = input;
  const log = deps.log;

  // 1) ロック済みユーザは即 deny (ガードを呼ばない)。
  if (deps.subsidiaryRepo.isLocked(sub.id, platform, userId)) {
    deps.subsidiaryRepo.recordRequest({
      subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
      instruction, decision: "deny", reason: "locked", violations: ["locked"], locked: true,
      guard_model: sub.guard_model,
    });
    log?.info(`subsidiary gate: locked user ${userId} (${sub.name})`);
    return { outcome: "locked", reason: "locked", replyText: "🔒 あなたはこの窓口でロックされています。 管理者に連絡してください。" };
  }

  // 1.5) コスト予算超過チェック。 ロックは無いが当日のトークン予算を使い切っていれば
  //      ガード (= Sonnet 呼び出しで更にトークンを使う) より前で止める。 ユーザの責ではない
  //      のでロックはしない。 予算未設定 (0) や budget 未注入なら素通り。
  const budgetStatus = deps.budget?.status(sub);
  if (budgetStatus?.blocked) {
    deps.subsidiaryRepo.recordRequest({
      subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
      instruction, decision: "deny",
      reason: `daily budget exceeded (${budgetStatus.todayTokens}/${budgetStatus.budget} tokens)`,
      violations: ["budget_exceeded"], locked: false, guard_model: sub.guard_model,
    });
    log?.info(`subsidiary gate: budget exceeded sub=${sub.name} ${budgetStatus.todayTokens}/${budgetStatus.budget}`);
    return {
      outcome: "budget_exceeded",
      reason: "daily budget exceeded",
      replyText: `💸 本日のコスト予算 (${fmtTokens(budgetStatus.budget)} トークン) を使い切りました。 明日の予算リセットまでお待ちください。`,
    };
  }

  // 2) ガード判定。 子会社が所有する delegation 複製 (cwd/project を内包) を根拠にする。
  const allowed = deps.subsidiaryRepo.listDelegations(sub.id);
  const allowedRefs = allowed.map((d) => ({
    call_name: d.call_name,
    title: d.title,
    description: d.description,
    default_cwd: d.default_cwd,
    project: d.project,
  }));
  const harnessRules = deps.harnessRepo.list().map((r) => ({ kind: r.kind, title: r.title, description: r.description }));

  const { verdict, raw } = await runGuard(
    {
      subsidiaryName: sub.display_name || sub.name,
      guardScope: sub.guard_scope,
      allowedDelegations: allowedRefs,
      harnessRules,
      instruction,
      userLabel,
    },
    { model: sub.guard_model || "sonnet", timeoutMs: GUARD_TIMEOUT_MS, runClaude: deps.runClaude },
  );

  // allow でも、 ガードが許可外の delegation を選んでいたら倒す (二重防御)。
  const allowedNames = new Set(allowed.map((d) => d.call_name));
  let effectiveCall = verdict.matched_call_name;
  if (verdict.decision === "allow") {
    if (!effectiveCall || !allowedNames.has(effectiveCall)) {
      // 既定 delegation があればそれにフォールバックせず、 安全側で deny。
      verdict.decision = "deny";
      verdict.reason = `${verdict.reason} / ガードが許可外の delegation (${effectiveCall ?? "なし"}) を選択したため拒否`;
      verdict.violations = [...new Set([...verdict.violations, "out_of_scope"])];
      effectiveCall = null;
    }
  }

  // 3) deny 経路: 記録 + 必要ならロック。
  if (verdict.decision === "deny") {
    const shouldLock = verdict.lock_user || verdict.violations.includes("injection");
    if (shouldLock) {
      deps.subsidiaryRepo.lock({
        subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
        reason: verdict.reason || verdict.violations.join(","),
      });
    }
    deps.subsidiaryRepo.recordRequest({
      subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
      instruction, decision: "deny", reason: verdict.reason, violations: verdict.violations,
      locked: shouldLock, guard_model: sub.guard_model, guard_raw: raw,
    });
    log?.info(`subsidiary gate: deny user=${userId} sub=${sub.name} lock=${shouldLock} violations=${verdict.violations.join(",")}`);
    const lockNote = shouldLock ? "\n🔒 このリクエストにより、 あなたをロックしました。" : "";
    return {
      outcome: "denied", reason: verdict.reason, verdict,
      replyText: `⛔ 受け付けられません: ${verdict.reason || "ハーネスルール違反"}${lockNote}`,
    };
  }

  // 4) allow 経路: 子会社が所有する delegation 複製を起動 (cwd/project は複製側が保持)。
  const callName = effectiveCall!;
  const owned = deps.subsidiaryRepo.findDelegation(sub.id, callName);
  if (!owned) {
    // ガードは allowedNames から選んだはずなので通常起きないが、 競合削除等で消えていたら安全側 deny。
    deps.subsidiaryRepo.recordRequest({
      subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
      instruction, decision: "deny", reason: `所有 delegation が見つかりません: ${callName}`,
      violations: ["out_of_scope"], matched_call_name: callName, guard_model: sub.guard_model, guard_raw: raw,
    });
    return { outcome: "denied", reason: "owned delegation not found", verdict, callName,
      replyText: `⛔ 受け付けられません: 指定の delegation (${callName}) が見つかりません。` };
  }
  // 4.5) intent 注入 (子会社のみ): instruction を prompt analyzer (heuristic/local LLM/
  //      haiku) に通し、 判定とハーネスルールを spawn プロンプトへ前置きする。
  //      注入は advisory の追加レイヤなので、 analyzer が失敗してもゲートは止めない
  //      (deny 判定は上の Sonnet ガードが担う)。
  let extraPrompt = instruction;
  try {
    const intent = await buildSubsidiaryIntentInjection({
      instruction,
      project: owned.project,
      rules: harnessRules,
      runClaude: deps.runClaude,
    });
    extraPrompt = `${intent.preamble}\n\n---\n\n${instruction}`;
    log?.info(
      `subsidiary gate: intent injected sub=${sub.name} decision=${intent.result.verdict.decision} ` +
      `risk=${intent.result.verdict.risk} source=${intent.result.source}`,
    );
  } catch (e) {
    log?.warn(`subsidiary gate: intent injection failed (proceeding without): ${(e as Error).message}`);
  }

  const result = await deps.delegationService.invokeDefinition(
    {
      template_id: null,
      call_name: owned.call_name,
      title: owned.title,
      target_provider: owned.target_provider as DelegationProvider,
      model: owned.model,
      prompt_template: owned.prompt_template,
      input_schema: owned.input_schema,
      default_cwd: owned.default_cwd,
      project: owned.project,
      emoji: owned.emoji,
    },
    {
      args: {},
      extra_prompt: extraPrompt,
      triggered_by: `subsidiary:${sub.name}:${platform}:${userId}`,
      subsidiary_id: sub.id,
    },
  );

  if (!result.ok) {
    deps.subsidiaryRepo.recordRequest({
      subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
      instruction, decision: "allow", reason: `delegation起動失敗: ${result.error}`,
      violations: verdict.violations, matched_call_name: callName, guard_model: sub.guard_model, guard_raw: raw,
    });
    log?.warn(`subsidiary gate: allow but spawn failed sub=${sub.name} call=${callName}: ${result.error}`);
    return { outcome: "spawn_failed", reason: result.error, verdict, callName,
      replyText: `⚠️ 承認されましたが起動に失敗しました: ${result.error}` };
  }

  deps.subsidiaryRepo.recordRequest({
    subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
    instruction, decision: "allow", reason: verdict.reason, violations: verdict.violations,
    matched_call_name: callName, run_id: result.run.id, guard_model: sub.guard_model, guard_raw: raw,
  });
  log?.info(`subsidiary gate: allow user=${userId} sub=${sub.name} call=${callName} run=${result.run.id}`);
  return {
    outcome: "allowed", reason: verdict.reason, verdict, callName, runId: result.run.id,
    replyText: `✅ 承認しました (${callName})。 作業セッションを起動します。`,
  };
}
