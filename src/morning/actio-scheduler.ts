import type { DelegationService } from "../delegation/service.js";
import type { TaskStore } from "../taskflow/store.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("morning/actio");

/** Morning intake stays within each Actio project/organization and sends references. */
export function startActioMorningScheduler(deps: {
  delegationService: DelegationService; store: TaskStore; now?: () => Date;
}): { stop(): void; runOnce(): Promise<void> } {
  const fired = new Set<string>();
  const now = deps.now ?? (() => new Date());
  let stopped = false;
  let running = false;
  const runOnce = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const date = now();
      const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const groups = new Map<string, Awaited<ReturnType<TaskStore["scan"]>>>();
      for (const task of await deps.store.scan()) {
        if (task.runtime?.status !== "pending" || typeof task.frontmatter.due_at !== "string" || !task.frontmatter.due_at.startsWith(today)) continue;
        const key = JSON.stringify([today, task.repoPath, task.runtime.subsidiary_id]);
        const group = groups.get(key) ?? [];
        group.push(task);
        groups.set(key, group);
      }
      for (const [key, tasks] of groups) {
        if (stopped || fired.has(key)) continue;
        const first = tasks[0]!;
        // Claim before dispatch: an unknown launch result must not trigger a
        // second launch during this scheduler's lifetime.
        fired.add(key);
        // One project's rejection must not skip the other projects' morning intake:
        // the groups are independent, and throwing here would leave every later
        // group undispatched until tomorrow while still marked as claimed.
        try {
          const result = await deps.delegationService.invoke({
            call_name: "morning-tasks", cwd: first.repoPath,
            subsidiary_id: first.runtime!.subsidiary_id,
            args: { task_list: tasks.map((task) => task.path).join("\n"), date: today },
            triggered_by: "morning-scheduler-actio",
          });
          if (!result.ok) log.warn("Actio morning delegation rejected; inspect intake before retry");
        } catch {
          log.warn("Actio morning delegation failed; inspect intake before retry");
        }
      }
    } finally { running = false; }
  };
  const timer = startSupervisedInterval("morning-actio", async () => {
    if (now().getHours() === 8) await runOnce();
  }, { intervalMs: 30 * 60 * 1000, initialDelayMs: 5_000, log: { warn: (message) => log.warn(message) } });
  return { stop: () => { stopped = true; timer.stop(); }, runOnce };
}
