/**
 * 人間の操作面 (chat platform) がデイリーゴールに使う口。
 *
 * @implements spec/feature/daily-goal-run.md — 2. 確定 / 6. 人間の停止 / カード / CC-DG-INV-01
 *
 * 確定と停止は人間本人の操作からだけ呼ばれる (公開 HTTP は持たない)。 役職の解決は
 * composition root が社員名簿で行い、 操作面は transport の本人性 (user / bot / webhook) を渡す。
 * カードの配達側はここから中身と配達状態の CAS を使う。
 */

import type { ConfirmResult } from "./service.js";
import type { DailyGoal, GoalCandidate, GoalDraft } from "./domain.js";
import type { DailyGoalCard } from "./repository.js";
import type { DailyGoalCardView } from "./card.js";
import type { buildCandidateCard } from "./card.js";

export interface SurfaceActor {
  userId: string;
  guildId: string;
  channelId: string;
  messageId?: string;
  isBot: boolean;
  isWebhook: boolean;
}

export type SurfaceCardContent =
  | { kind: "goal"; goalId: string; view: DailyGoalCardView }
  | { kind: "candidate"; candidate: GoalCandidate; view: ReturnType<typeof buildCandidateCard> }
  | null;

export interface DailyGoalSurfacePort {
  isEnabled(): boolean;
  /** receiptId は確定操作の受付 ID (interaction id)。 同じ操作の再送は同じゴールを返す。 */
  confirm(input: { draft: GoalDraft; actor: SurfaceActor; receiptId: string }): ConfirmResult;
  stop(goalId: string, actor: SurfaceActor): DailyGoal;
  candidate(candidateId: string): GoalCandidate | null;
  /** 起動時刻を過ぎていれば今すぐ起動を試みる (scheduler の次 tick を待たない)。 */
  launchSoon(): void;
  /** 起動予定時刻 (epoch ms)。 */
  launchAtFor(goal: DailyGoal): number;
  cards: {
    pending(now: number): DailyGoalCard[];
    unknown(): DailyGoalCard[];
    content(card: DailyGoalCard, now: number): SurfaceCardContent;
    claim(cardId: string, channelId: string): boolean;
    saved(cardId: string, revision: number, channelId: string, messageId: string): void;
    rejected(cardId: string, error: string, now: number): void;
    unknownResult(cardId: string, error: string): void;
  };
}
