/**
 * 操作面の口 (DailyGoalSurfacePort) を service と社員名簿から組み立てる。
 *
 * @implements spec/feature/daily-goal-run.md — 2. 確定 / 6. 人間の停止
 *
 * 役職は操作のたびに名簿を live 参照する。 確定の直後は起動時刻を過ぎていれば
 * その場で起動を試みる (7:30 以降の確定は確定時に起動する)。
 */

import { launchAt } from "./launch-policy.js";
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
    confirm: (input) => service.confirmGoal({ draft: input.draft, actor: actor(input.actor), receiptId: input.receiptId, now: now() }),
    stop: (goalId, input) => service.stopByHuman(goalId, actor(input), now()),
    candidate: (id) => service.candidate(id),
    launchSoon: () => {
      void service.launchDue(now()).catch((error) => service.deps.log?.warn(`daily goal immediate launch failed: ${String(error)}`));
    },
    launchAtFor: (goal) => launchAt(goal.confirmedAt, goal.date, service.deps.config().launchTime),
    cards: {
      pending: (at) => repo.pendingCards(at),
      unknown: () => repo.unknownCards(),
      content: (card, at) => service.cardContent(card, at),
      claim: (cardId, channelId) => repo.claimCard(cardId, channelId),
      saved: (cardId, revision, channelId, messageId) => repo.saveCard(cardId, revision, channelId, messageId),
      rejected: (cardId, error, at) => repo.cardRejected(cardId, error, at),
      unknownResult: (cardId, error) => repo.cardUnknown(cardId, error),
    },
  };
}
