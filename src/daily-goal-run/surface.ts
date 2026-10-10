/**
 * 操作面の口 (DailyGoalSurfacePort) を service と社員名簿から組み立てる。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 投稿 / 2. 聞き返し / 6. 人間の停止 / 8. まとめの再送
 *
 * 役職は操作のたびに名簿を live 参照する。 登録した直後に起動を試みる (起動時刻の制限は無い)。
 */

import { CHANNEL_TOPIC } from "./post-replies.js";
import type { GoalActor } from "./domain.js";
import type { DailyGoalRunService } from "./service.js";
import type { DailyGoalSurfacePort, SurfaceActor } from "./surface-port.js";

export function createDailyGoalSurface(service: DailyGoalRunService, opts: {
  roleOf: (userId: string) => GoalActor["role"];
  isEnabled: () => boolean;
  now?: () => number;
}): DailyGoalSurfacePort {
  const now = opts.now ?? Date.now;
  const actor = (input: SurfaceActor): GoalActor => ({ platform: "discord", ...input, role: opts.roleOf(input.userId) });
  const { repo } = service.deps;
  return {
    isEnabled: opts.isEnabled,
    channelTopic: () => CHANNEL_TOPIC,
    intake: {
      post: (input) => service.intake.intakePost({ text: input.text, messageId: input.messageId, actor: actor(input.actor), now: now() }),
      edited: (input) => service.intake.postEdited({ text: input.text, messageId: input.messageId, actor: actor(input.actor), now: now() }),
      threadReply: (input) => service.intake.supplementDraft({ threadId: input.threadId, text: input.text, actor: actor(input.actor), now: now() }),
      attachThread: (draftId, threadId) => service.intake.attachThread(draftId, threadId, now()),
    },
    stop: (goalId, input) => service.stopByHuman(goalId, actor(input), now()),
    resendSummary: (date, input) => service.resendSummary(date, actor(input), now()),
    cards: {
      pending: (at) => repo.pendingCards(at),
      unknown: () => repo.unknownCards(),
      content: (card, at) => service.cardContent(card, at),
      claim: (cardId, channelId) => repo.claimCard(cardId, channelId),
      saved: (cardId, revision, channelId, messageId) => service.cardDelivered(cardId, revision, channelId, messageId, now()),
      rejected: (cardId, error, at) => repo.cardRejected(cardId, error, at),
      unknownResult: (cardId, error) => repo.cardUnknown(cardId, error),
    },
  };
}
