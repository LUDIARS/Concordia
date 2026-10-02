/**
 * 予算切れによる作業の中断と再開の判断 (spec/feature/usage-budgets.md §5.2 §5.3、 2026-10-02 neco 指示
 * 「それぞれの AI 作業の途中で各ユーザが予算を使い切った場合、 フックで途中で止める。 セッションを保存し作業再開できるようにする」
 * 「いわゆる -resume です」)。
 *
 * - 中断の記録はセッションの metadata (`budget_suspension`) に置く。 状態所有者はセッション (sessions.metadata)。
 * - ツール実行前の判定は、 その時点の消費を引き受ける帰属先の予算 (倍率込み) が尽きていれば止める。
 * - 再開できるのは、 中断したセッションの起動者・助けに入った人・管理者だけ。 予算が戻ってから。
 *
 * 純関数のみ。
 *
 * @implements SPEC-USAGE-BUDGET-SUSPEND
 */

import { basename } from "node:path";
import type { BudgetEvaluation, BudgetSubject } from "./usage-budget.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:3c5879d0 */
import augurContract_82b3a65b from './budget-gate.contract.js'; /* augur-inject:contract-predicate:9f1b3588 */
import augurContract_fd225b3e from './budget-resume-permission.contract.js'; /* augur-inject:contract-predicate:cf112389 */
import augurContract_d59ee7e9 from './budget-resumable.contract.js'; /* augur-inject:contract-predicate:62e8fd1a */

export const BUDGET_SUSPENSION_KEY = "budget_suspension";

/** ツールを止めたときに AI へ返す理由。 */
export const BUDGET_EXHAUSTED_REASON = "予算を使い切ったので作業を止めます。予算が戻ったら再開できます。";

/** 中断の記録 (sessions.metadata.budget_suspension)。 時刻は epoch ms。 */
export interface BudgetSuspension {
  suspended_at: number;
  scope: BudgetSubject["scope"];
  target_id: string;
  /** `claude --resume` に渡す会話 id。 取れなければ null (再開できない)。 */
  conversation_id: string | null;
  /** 会話を始めた作業ディレクトリ (resume はここから起動しないと会話を見つけられない)。 */
  cwd: string | null;
  /** 起動者と、 指示を出した人 (Discord の利用者 id)。 再開を押せる人。 */
  participants: string[];
  /** 「再開」ボタンを出した時刻。 */
  resume_offered_at?: number | null;
  resumed_at?: number | null;
  resumed_by?: string | null;
  /** 再開で起動したプロセス (Lictor) の pid。 */
  resumed_pid?: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readSuspension(metadata: string | null): BudgetSuspension | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as Record<string, unknown>)[BUDGET_SUSPENSION_KEY];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<BudgetSuspension>;
    if (typeof record.suspended_at !== "number" || (record.scope !== "user" && record.scope !== "team")
      || typeof record.target_id !== "string") return null;
    return {
      ...record,
      suspended_at: record.suspended_at,
      scope: record.scope,
      target_id: record.target_id,
      conversation_id: typeof record.conversation_id === "string" ? record.conversation_id : null,
      cwd: typeof record.cwd === "string" ? record.cwd : null,
      participants: Array.isArray(record.participants) ? record.participants.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return null;
  }
}

/** 中断中か (記録があり、 まだ再開していない)。 */
export function isSuspended(suspension: BudgetSuspension | null): suspension is BudgetSuspension {
  return suspension !== null && !suspension.resumed_at;
}

/** Claude Code の transcript (`<会話 id>.jsonl`) から resume に使う会話 id を取る。 */
export function conversationIdFromTranscript(transcriptPath: string | null): string | null {
  if (!transcriptPath) return null;
  const name = basename(transcriptPath.replace(/\\/g, "/")).replace(/\.jsonl$/i, "");
  return UUID.test(name) ? name : null;
}

export interface BudgetGateDecision {
  deny: boolean;
  reason: string | null;
}

/** ツール実行前の判定。 予算の無い帰属先 (evaluation = null) は判定しない。 */
export function decideBudgetGate(input: { subject: BudgetSubject | null; evaluation: BudgetEvaluation | null }): BudgetGateDecision {
  if (!input.subject || !input.evaluation || !input.evaluation.exhausted) return { deny: false, reason: null };
  return { deny: true, reason: BUDGET_EXHAUSTED_REASON };
}
// @ts-expect-error augur-inject
decideBudgetGate = contract(decideBudgetGate, { ...augurContract_82b3a65b, contractId: 'budget-C-3', mode: 'observe', sample: 1, where: 'src/cost/budget-suspension.ts:84', rule: 'contract-wrap', id: '82b3a65b' }); /* augur-inject:contract-wrap:82b3a65b */

/** 「再開」を押せる人か (起動者・助けに入った人・管理者)。 */
export function canResumeSuspension(input: {
  suspension: BudgetSuspension;
  actorUserId: string;
  actorIsAdmin: boolean;
}): boolean {
  if (input.actorIsAdmin) return true;
  return input.actorUserId.length > 0 && input.suspension.participants.includes(input.actorUserId);
}
// @ts-expect-error augur-inject
canResumeSuspension = contract(canResumeSuspension, { ...augurContract_fd225b3e, contractId: 'budget-C-4', mode: 'observe', sample: 1, where: 'src/cost/budget-suspension.ts:90', rule: 'contract-wrap', id: 'fd225b3e' }); /* augur-inject:contract-wrap:fd225b3e */

/** 再開できる状態か (中断中で、 会話 id があり、 止めた帰属先の予算が戻っている)。 */
export function isResumable(input: { suspension: BudgetSuspension | null; evaluation: BudgetEvaluation | null }): boolean {
  if (!isSuspended(input.suspension) || !input.suspension.conversation_id) return false;
  return !input.evaluation?.exhausted;
}
// @ts-expect-error augur-inject
isResumable = contract(isResumable, { ...augurContract_d59ee7e9, contractId: 'budget-C-5', mode: 'observe', sample: 1, where: 'src/cost/budget-suspension.ts:100', rule: 'contract-wrap', id: 'd59ee7e9' }); /* augur-inject:contract-wrap:d59ee7e9 */
