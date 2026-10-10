/**
 * 人間の操作面 (chat platform) がデイリーゴールに使う口。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 投稿 / 2. 聞き返し / 6. 人間の停止 / 8. まとめの再送 / カード / CC-DG-INV-01
 *
 * 登録・停止・再送は人間本人の操作からだけ呼ばれる (公開 HTTP は持たない)。 役職の解決は
 * composition root が社員名簿で行い、 操作面は transport の本人性 (user / bot / webhook) を渡す。
 * カードの配達側はここから中身と配達状態の CAS を使う。
 */

import type { DailyGoalCardContent } from "./service.js";
import type { DailyGoal, DailyGoalDay } from "./domain.js";
import type { DailyGoalCard } from "./repository.js";
import type { IntakeResult } from "./post-intake.js";

export interface SurfaceActor {
  userId: string;
  guildId: string;
  channelId: string;
  messageId?: string;
  isBot: boolean;
  isWebhook: boolean;
}

export type SurfaceCardContent = DailyGoalCardContent;

export interface DailyGoalSurfacePort {
  isEnabled(): boolean;
  /** チャンネルの説明 (投稿の書き方)。 */
  channelTopic(): string;
  intake: {
    /** チャンネル直下の人間の投稿。 */
    post(input: { text: string; messageId: string; actor: SurfaceActor }): Promise<IntakeResult>;
    /** 元投稿の編集。 */
    edited(input: { text: string; messageId: string; actor: SurfaceActor }): Promise<IntakeResult>;
    /** 聞き返しスレッドでの返信。 */
    threadReply(input: { threadId: string; text: string; actor: SurfaceActor }): Promise<IntakeResult>;
    /** 操作面が作ったスレッドを下書きに結び付ける。 */
    attachThread(draftId: string, threadId: string): void;
  };
  stop(goalId: string, actor: SurfaceActor): DailyGoal;
  resendSummary(date: string, actor: SurfaceActor): Promise<DailyGoalDay>;
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
