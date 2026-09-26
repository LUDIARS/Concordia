import type { TaskPrEvidence } from "./pr-evidence.js";

export interface PlanningTask {
  id: string;
  status: string;
  blockedBy: readonly string[];
  isCriticalPath: boolean;
  slackDays: number | null;
  criticalPathError: string | null;
  pullRequests: readonly TaskPrEvidence[];
  workingSessionId?: string | null;
}

export function taskWaitReason(task: PlanningTask, tasks: readonly PlanningTask[], sessionId?: string): string | null {
  if (task.status !== "open" && !(task.status === "in_progress" && sessionId && task.workingSessionId === sessionId)) return task.status;
  if (task.criticalPathError) return task.criticalPathError;
  if (task.blockedBy.some((id) => tasks.find((other) => other.id === id)?.status !== "done")) return "dependency";
  if (task.pullRequests.some((pr) => pr.state === "closed")) return "closed_pr";
  if (task.pullRequests.some((pr) => pr.state === "merged")) return "reflection";
  if (task.pullRequests.some((pr) => ["queued", "running", "pending", "reviewing"].includes(pr.review))) return "review";
  // Ready review is actionable, but the continuation prompt still requires
  // checking existing human authorization before merge or deployment.
  return null;
}

/** Priority selects a candidate; it never grants execution authority. */
export function selectContinuationTask(tasks: readonly PlanningTask[]): PlanningTask | null {
  return tasks.filter((task) => !taskWaitReason(task, tasks)).sort((a, b) =>
    Number(b.isCriticalPath) - Number(a.isCriticalPath)
    || (a.slackDays ?? Infinity) - (b.slackDays ?? Infinity)
    || a.id.localeCompare(b.id))[0] ?? null;
}
