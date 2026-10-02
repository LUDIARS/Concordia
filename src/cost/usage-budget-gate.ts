/**
 * ツール実行前の予算の判定と中断 (spec/feature/usage-budgets.md §5.2)。 ハーネスの gate (/v1/harness/gate) から呼ぶ。
 *
 * - その時点の消費を引き受ける帰属先 (直前に指示を出した人で決まる) の予算が尽きていれば deny する。
 *   集計は tracker のキャッシュ (数分) を使い、 ツール実行ごとにログを読まない。 予算が無い帰属先は判定しない。
 * - 初めて尽きたときに 1 回だけ中断の記録 (時刻・帰属先・会話 id・作業ディレクトリ・再開を押せる人) をセッションに残し、
 *   通常の終了手順でセッションを終える。 記録したあとのツールも止め続ける (終了までの間に作業を進めない)。
 *
 * @implements SPEC-USAGE-BUDGET-SUSPEND
 */

import type { SessionRow } from "../shared/types.js";
import type { UsageBudgetTracker } from "./usage-budget-tracker.js";
import { responsibleAt } from "./usage-attribution.js";
import {
  BUDGET_EXHAUSTED_REASON,
  BUDGET_SUSPENSION_KEY,
  decideBudgetGate,
  isSuspended,
  readSuspension,
  type BudgetSuspension,
} from "./budget-suspension.js";
import type { BudgetSubject } from "./usage-budget.js";
import type { ConversationLaunch } from "./conversation-launch.js";

export interface UsageBudgetGateDeps {
  tracker: Pick<UsageBudgetTracker, "attributionFor" | "cachedStatus">;
  findSession(id: string): SessionRow | null;
  mergeMetadata(id: string, partial: Record<string, unknown>): void;
  readConversation(session: SessionRow): Promise<ConversationLaunch>;
  /** 通常の終了手順でセッションを終える (admin stop と同じ)。 */
  endSession(sessionId: string): Promise<void>;
  log: { warn(obj: unknown, msg?: string): void };
  now?: () => number;
}

export type UsageBudgetGateVerdict =
  | { deny: false }
  | { deny: true; reason: string; subject: BudgetSubject | null };

export class UsageBudgetGate {
  private readonly now: () => number;
  private readonly suspending = new Set<string>();

  constructor(private readonly deps: UsageBudgetGateDeps) {
    this.now = deps.now ?? Date.now;
  }

  async check(sessionId: string): Promise<UsageBudgetGateVerdict> {
    const session = this.deps.findSession(sessionId);
    if (!session) return { deny: false };
    const existing = readSuspension(session.metadata);
    if (isSuspended(existing)) {
      return { deny: true, reason: BUDGET_EXHAUSTED_REASON, subject: { scope: existing.scope, targetId: existing.target_id } };
    }
    const nowMs = this.now();
    const attribution = this.deps.tracker.attributionFor(session);
    const { subject } = responsibleAt(attribution, nowMs);
    if (!subject) return { deny: false };
    const evaluation = await this.deps.tracker.cachedStatus(subject, nowMs);
    const decision = decideBudgetGate({ subject, evaluation });
    if (!decision.deny) return { deny: false };
    this.suspendOnce(session, subject, [
      ...(attribution.launcherUserId ? [attribution.launcherUserId] : []),
      ...attribution.instructions.map((mark) => mark.userId),
    ], nowMs);
    return { deny: true, reason: decision.reason ?? BUDGET_EXHAUSTED_REASON, subject };
  }

  /** 中断の記録と終了は gate の応答を待たせずに 1 回だけ行う。 */
  private suspendOnce(session: SessionRow, subject: BudgetSubject, participants: string[], nowMs: number): void {
    if (this.suspending.has(session.id)) return;
    this.suspending.add(session.id);
    void (async () => {
      const conversation = await this.deps.readConversation(session)
        .catch((): ConversationLaunch => ({ conversationId: null, cwd: session.repo_path || null }));
      const record: BudgetSuspension = {
        suspended_at: nowMs,
        scope: subject.scope,
        target_id: subject.targetId,
        conversation_id: conversation.conversationId,
        cwd: conversation.cwd,
        participants: [...new Set(participants)],
        resume_offered_at: null,
        resumed_at: null,
        resumed_by: null,
      };
      this.deps.mergeMetadata(session.id, { [BUDGET_SUSPENSION_KEY]: record });
      await this.deps.endSession(session.id);
    })()
      .catch((error) => this.deps.log.warn({ err: (error as Error).message, session_id: session.id }, "budget suspension failed"))
      .finally(() => this.suspending.delete(session.id));
  }
}
