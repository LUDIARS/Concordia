/**
 * 子会社ゲート。 出張先からの作業指示 1 件を:
 *   1. ロック済みユーザなら即 deny
 *   2. Sonnet ガード (guard.ts) で判定
 *   3. 監査記録 (subsidiary_requests)
 *   4. deny かつ lock 推奨ならユーザをロック
 *   5. allow なら専用 delegation を起動 (subsidiary_id + 既定 team タグ付き)
 * まで一気に処理し、 出張先へ返す文面 (replyText) を返す。
 *
 * Bot (Discord/Slack) はこのゲートを呼ぶだけで、 ガードの中身を知らない (SRP)。
 */

import type { SubsidiaryRepo, SubsidiaryRow } from "../db/subsidiary-repo.js";
import type { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import type { DelegationProvider, DelegationRepo } from "../db/delegation-repo.js";
import type { DelegationService } from "../delegation/service.js";
import type { SubsidiaryBudgetStatus } from "./budget.js";
import { runGuard, type GuardVerdict } from "./guard.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import { buildSubsidiaryIntentInjection } from "./intent-inject.js";
import { isProjectNameInScope } from "./project-scope.js";

export interface SubsidiaryGateDeps {
  subsidiaryRepo: SubsidiaryRepo;
  harnessRepo: HarnessRulesRepo;
  delegationRepo: DelegationRepo;
  delegationService: DelegationService;
  runClaude: RunClaudeFn;
  /** 子会社の日次トークン予算判定 (省略時は予算チェックを行わない = 無制限)。 */
  budget?: { status: (sub: { id: string; daily_token_budget: number }) => Promise<SubsidiaryBudgetStatus> };
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
  /** allow だが同時実行上限で待ち行列に入った (まだ起動していない)。 */
  queued?: boolean;
  /** queued のときの待ち順 (1 始まり)。 */
  queuePosition?: number | null;
  /** 出張先へ返す日本語文面。 */
  replyText: string;
}

const GUARD_TIMEOUT_MS = Number(process.env.CONCORDIA_SUBSIDIARY_GUARD_TIMEOUT_MS ?? "60000") || 60000;

/** トークン数を人が読みやすい桁 (1,234k / 1,234) に整形する。 */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000).toLocaleString("en-US")}k`;
  return n.toLocaleString("en-US");
}

/** 評価フェーズ (ロック/予算/ガード/deny 記録) の結果。 allow 時は verdict を持ち帰る。 */
export type GateEvaluation =
  | { ok: false; result: GateResult }
  | {
    ok: true;
    verdict: GuardVerdict;
    raw: string;
    effectiveCall: string | null;
    /** advisoryGuard 時のみ: 有効なガード出力は deny 所見だったが advisory として通した。 */
    guardDenied?: boolean;
  };

/**
 * ロック → 予算 → Sonnet ガード → (deny なら記録 + ロック) までの評価フェーズ。
 * spawn は行わない。 受付チャンネル (processSubsidiaryRequest) と forum spawn
 * (guardSubsidiaryForumSpawn) が共有する。
 *
 * `requireOwnedCall`: 受付経路は allow 時に「所有 delegation のどれか」が選ばれている
 * ことを要求する (二重防御)。 forum spawn は起動テンプレを Cc 側の selector が選ぶため、
 * ガードには decision だけを求める。
 *
 * `advisoryGuard`: Sonnet ガードの有効な deny を停止でなく所見 (advisory) として扱う。
 * セッション起動の判断は権限を持つ人間が行う (2026-09-02 neco 指示) — forum spawn は
 * session_spawn 権限 (管理職以上) か管理職承認を通過した後にここへ来るため、
 * ガード所見で人間の判断を上書きしない。ガード実行・解釈失敗は所見ではないため、
 * ロック済みユーザと予算超過と同様に fail-closed で停止する。
 */
export async function evaluateSubsidiaryRequest(
  deps: SubsidiaryGateDeps,
  input: GateInput,
  opts: { requireOwnedCall: boolean; advisoryGuard?: boolean },
): Promise<GateEvaluation> {
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
    return {
      ok: false,
      result: { outcome: "locked", reason: "locked", replyText: "🔒 あなたはこの窓口でロックされています。 管理者に連絡してください。" },
    };
  }

  // 1.5) コスト予算超過チェック。 ロックは無いが当日のトークン予算を使い切っていれば
  //      ガード (= Sonnet 呼び出しで更にトークンを使う) より前で止める。 ユーザの責ではない
  //      のでロックはしない。 予算未設定 (0) や budget 未注入なら素通り。
  const budgetStatus = await deps.budget?.status(sub);
  if (budgetStatus?.blocked) {
    deps.subsidiaryRepo.recordRequest({
      subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
      instruction, decision: "deny",
      reason: `daily budget exceeded (${budgetStatus.todayTokens}/${budgetStatus.budget} tokens)`,
      violations: ["budget_exceeded"], locked: false, guard_model: sub.guard_model,
    });
    log?.info(`subsidiary gate: budget exceeded sub=${sub.name} ${budgetStatus.todayTokens}/${budgetStatus.budget}`);
    return {
      ok: false,
      result: {
        outcome: "budget_exceeded",
        reason: "daily budget exceeded",
        replyText: `💸 本日のコスト予算 (${fmtTokens(budgetStatus.budget)} トークン) を使い切りました。 明日の予算リセットまでお待ちください。`,
      },
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
      // forum spawn は起動テンプレを Cc 側 selector が選ぶため matched_call_name を求めない。
      mode: opts.requireOwnedCall ? "intake" : "forum",
    },
    { model: sub.guard_model || "sonnet", timeoutMs: GUARD_TIMEOUT_MS, runClaude: deps.runClaude },
  );

  // allow でも、 ガードが許可外の delegation を選んでいたら倒す (二重防御)。
  const allowedNames = new Set(allowed.map((d) => d.call_name));
  let effectiveCall = verdict.matched_call_name;
  if (verdict.decision === "allow" && opts.requireOwnedCall) {
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
    const guardFailed = verdict.violations.includes("guard_error");
    if (opts.advisoryGuard && !guardFailed) {
      // 起動判断は権限を持つ人間に委ねる: deny 所見は advisory として通す。監査行は
      // 呼び出し側が「所見つき allow」として 1 行で残す (二重記録を避ける)。
      // ロックもしない — 権限者を誤検知で凍結すると受付チャンネルまで巻き添えになる。
      // violations はモデル出力なので、内容をログへ埋め込まず件数だけを記録する。
      log?.info(
        `subsidiary gate: guard deny treated as advisory user=${userId} sub=${sub.name} `
        + `violation_count=${verdict.violations.length}`,
      );
      return { ok: true, verdict, raw, effectiveCall: null, guardDenied: true };
    }
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
    // 実行例外の message や不正なモデル出力は内部パス・設定を含み得る。
    // 詳細は監査記録に残し、外部チャネルには固定文だけを返す。
    const replyReason = guardFailed
      ? "ガードを正常に完了できませんでした (fail-closed)"
      : verdict.reason || "ハーネスルール違反";
    return {
      ok: false,
      result: {
        outcome: "denied", reason: verdict.reason, verdict,
        replyText: `⛔ 受け付けられません: ${replyReason}${lockNote}`,
      },
    };
  }

  return { ok: true, verdict, raw, effectiveCall };
}

export async function processSubsidiaryRequest(deps: SubsidiaryGateDeps, input: GateInput): Promise<GateResult> {
  const { subsidiary: sub, platform, userId, userLabel, instruction } = input;
  const log = deps.log;

  const evaluation = await evaluateSubsidiaryRequest(deps, input, { requireOwnedCall: true });
  if (!evaluation.ok) return evaluation.result;
  const { verdict, raw, effectiveCall } = evaluation;
  const harnessRules = deps.harnessRepo.list().map((r) => ({ kind: r.kind, title: r.title, description: r.description }));

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
  // 4.1) 関係プロジェクト外への起動を止める (spec §3.4)。 Test forum の掲載範囲と同じ集合で、
  //      TaskWorkflow に載る run も子会社の担当プロジェクトだけに縛る。 project 未設定 /
  //      未解決も deny — 確認できないものを通すと縛りが無いのと同じになる。
  const projects = deps.subsidiaryRepo.listProjects(sub.id);
  if (!isProjectNameInScope(owned.project, projects)) {
    const scopeLabel = projects.length ? projects.join(", ") : "未設定";
    deps.subsidiaryRepo.recordRequest({
      subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
      instruction, decision: "deny",
      reason: `関係プロジェクト外: ${owned.project ?? "(未設定)"} (許可=${scopeLabel})`,
      violations: ["out_of_scope"], matched_call_name: callName, guard_model: sub.guard_model, guard_raw: raw,
    });
    // project 設定は管理 API 入力なので、診断ログは JSON 化して改行によるログ偽装を防ぐ。
    log?.warn(
      `subsidiary gate: project out of scope sub=${sub.name} call=${callName} `
      + `project=${JSON.stringify(owned.project)} scope=${JSON.stringify(projects)}`,
    );
    return {
      outcome: "denied", reason: "project out of scope", verdict, callName,
      replyText: "⛔ 受け付けられません: この窓口の担当範囲外です。",
    };
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
      // DelegationService → pending spawn → session.team_id → Discord team surface まで
      // 既存の canonical team 経路で運ぶ。未設定なら従来どおり team 無し。
      ...(sub.default_team_id ? { options: { team: sub.default_team_id } } : {}),
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
  log?.info(
    `subsidiary gate: allow user=${userId} sub=${sub.name} call=${callName} run=${result.run.id} ` +
    `queued=${result.queued ? 1 : 0}`,
  );
  // 同時実行上限に達していれば spawn されず待ち行列に入る。 「起動します」 と答えると
  // 実際には動いていないのに動いた事になるので、 待ち状態はそのまま伝える。
  const replyText = result.queued
    ? `🕒 承認しました (${callName})。 同時実行の上限に達しているため、 順番待ちに入れました` +
      `${result.queue_position ? ` (${result.queue_position} 番目)` : ""}。 空き次第 自動で起動します。`
    : `✅ 承認しました (${callName})。 作業セッションを起動します。`;
  return {
    outcome: "allowed", reason: verdict.reason, verdict, callName, runId: result.run.id,
    queued: result.queued, queuePosition: result.queue_position,
    replyText,
  };
}

/** forum spawn ガードの結果。 advisoryText はスレッドに注記して起動を続けるための所見文。 */
export interface ForumSpawnGuardResult {
  ok: boolean;
  replyText: string;
  advisoryText?: string;
}

/**
 * 子会社 forum spawn 用のガード入口。 評価フェーズ (ロック/予算/ガード) を通し、
 * allow は監査記録だけ残して spawn は呼び出し側 (forum-spawn.ts の template selector +
 * /v1/delegation/invoke) に委ねる。 spec/feature/subsidiary-delegation.md §3.1。
 *
 * Sonnet ガードの有効な deny は advisory (2026-09-02 neco 指示): 起動判断は権限を持つ人間の
 * ものなので、所見をスレッド注記 + 監査記録に残して起動は継続する。停止するのは
 * ロック済みユーザ、予算超過、ガード実行・解釈失敗。
 */
export async function guardSubsidiaryForumSpawn(
  deps: SubsidiaryGateDeps,
  input: GateInput,
): Promise<ForumSpawnGuardResult> {
  const evaluation = await evaluateSubsidiaryRequest(deps, input, { requireOwnedCall: false, advisoryGuard: true });
  if (!evaluation.ok) return { ok: false, replyText: evaluation.result.replyText };
  const { subsidiary: sub, platform, userId, userLabel, instruction } = input;
  const guardDenied = evaluation.guardDenied === true;
  deps.subsidiaryRepo.recordRequest({
    subsidiary_id: sub.id, platform, platform_user_id: userId, user_label: userLabel,
    // 実際に起動へ進むので decision は allow に固定する (deny = ブロックされた、の
    // 監査上の不変条件を守る)。ガードの deny 所見は reason と violations に残す。
    instruction, decision: "allow",
    reason: guardDenied
      ? `ガード所見 deny を advisory として通過: ${evaluation.verdict.reason} (forum spawn)`
      : `${evaluation.verdict.reason} (forum spawn)`,
    violations: evaluation.verdict.violations,
    matched_call_name: null,
    guard_model: sub.guard_model, guard_raw: evaluation.raw,
  });
  deps.log?.info(
    `subsidiary gate: forum spawn allow user=${userId} sub=${sub.name}${guardDenied ? " (guard advisory)" : ""}`,
  );
  if (!guardDenied) return { ok: true, replyText: "" };
  return {
    ok: true,
    replyText: "",
    // reason はガードへ渡した内部スコープ・delegation metadata を含み得るため、
    // 外部 guild へは転記しない。詳細は access-controlled な監査記録にだけ残す。
    advisoryText:
      "⚠️ ガード所見 (advisory): ハーネスルール上の懸念を検出しました。\n"
      + "詳細は監査記録に保存しました。起動判断は権限者に委ねられているため、セッション起動は継続します。",
  };
}
