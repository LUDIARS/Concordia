import type { RevisorLocalPr, SessionRow, TaskflowOverviewTask } from "../../api.js";

/** @implements spec/feature/session-message-webui-chat.md §1.2.1 — explicit task/session relation */
export function isSessionTask(task: Pick<TaskflowOverviewTask, "source_session" | "parent_session_id" | "child_session_id">, sessionId: string): boolean {
  return [task.source_session, task.parent_session_id, task.child_session_id].includes(sessionId);
}

function repositoryKey(origin: string): string {
  return origin.trim().replace(/\\/g, "/").replace(/^git@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "").replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase();
}

/** Same shared main is insufficient evidence that a PR belongs to this session. */
export function isSessionPr(pr: Pick<RevisorLocalPr, "sessionId" | "repository" | "headRef">, session: Pick<SessionRow, "id" | "repo_origin" | "branch">): boolean {
  if (pr.sessionId === session.id) return true;
  if (!session.repo_origin || !session.branch || ["main", "master", "develop"].includes(session.branch.toLowerCase())) return false;
  return repositoryKey(pr.repository) === repositoryKey(session.repo_origin) && pr.headRef === session.branch;
}
