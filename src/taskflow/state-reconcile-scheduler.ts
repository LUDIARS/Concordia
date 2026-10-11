/**
 * 状態の写しの照合を定期実行する (spec/feature/task-workflow-v3.md §状態の写し)。
 * Actio が止まっている間は失敗を記録して次の周期を待つ。照合は読むだけなので、
 * 取りこぼしても次の周期で追いつく。
 */
import { createChildLogger } from "../shared/logger.js";
import type { TaskflowStateStore } from "./state-store.js";
import type { TaskStore } from "./store.js";
import { reconcileTaskStatuses, type StatusDrift, type StatusReconcilePorts } from "./state-reconcile.js";

const log = createChildLogger("taskflow/state-reconcile");
export const STATE_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

export function taskStatusReconcilePorts(store: TaskStore, state: TaskflowStateStore): StatusReconcilePorts {
  return {
    scan: () => store.scan(),
    cached: (repoPath: string, reference: string) => state.find({ repoPath, taskPath: reference })?.status ?? null,
    write: (drift: StatusDrift) => {
      state.update({ repoPath: drift.repoPath, taskPath: drift.reference }, { status: drift.to });
    },
  };
}

export function startTaskStatusReconcile(
  store: TaskStore, state: TaskflowStateStore, intervalMs = STATE_RECONCILE_INTERVAL_MS,
): { stop(): void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileTaskStatuses(taskStatusReconcilePorts(store, state), { apply: true });
      if (result.drift.length > 0) log.info({ checked: result.checked, updated: result.drift.length }, "taskflow status cache reconciled with Actio");
    } catch (error) {
      log.warn({ err: (error as Error).message }, "taskflow status reconcile skipped");
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
