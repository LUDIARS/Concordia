/**
 * 交代状態の照合ループ。
 *
 * Cc が再起動しても、保存済みの交代状態から次の一手を再開する。 後継の起動応答を
 * 失った場合も run を照合して進めるので、同じ後継を二重に起動しない。
 * 1 件の失敗で他の交代を止めない。
 *
 * @implements spec/feature/astra-with-sidecar.md §不変条件と復旧
 */

import type { ConversationService } from "./service.js";
import type { ConversationRepo } from "./repo.js";

export const CONVERSATION_RECONCILE_INTERVAL_MS = 30_000;

const OPEN_STATES = [
  "handoff_pending",
  "handoff_saved",
  "successor_requested",
  "successor_ready",
  "routing_switched",
] as const;

export async function reconcileConversationHandoffs(input: {
  repo: ConversationRepo;
  service: Pick<ConversationService, "advance">;
  onError?: (handoffId: string, error: Error) => void;
}): Promise<number> {
  let advanced = 0;
  for (const handoff of input.repo.listHandoffs(OPEN_STATES)) {
    try {
      const after = await input.service.advance(handoff.id);
      if (after && after.state !== handoff.state) advanced += 1;
    } catch (error) {
      input.onError?.(handoff.id, error as Error);
    }
  }
  return advanced;
}

export function startConversationReconciler(input: {
  repo: ConversationRepo;
  service: Pick<ConversationService, "advance">;
  intervalMs?: number;
  onError?: (handoffId: string, error: Error) => void;
}): { stop(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileConversationHandoffs(input);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, input.intervalMs ?? CONVERSATION_RECONCILE_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}
