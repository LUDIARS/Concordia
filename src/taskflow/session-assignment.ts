import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationRepo } from "../db/delegation-repo.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { mainRepositoryKey } from "./repository-identity.js";
import type { TaskStore } from "./store.js";

/** Project session lifecycle onto task metadata without assigning a reader or parent. */
export async function syncTaskSessionAssignment(input: {
  sessionId: string; ended: boolean; sessions: SessionsRepo; delegation: DelegationRepo; store: TaskStore;
}): Promise<void> {
  const { store, sessionId } = input;
  if (!store.setWorkingSession) return;
  if (input.ended) {
    await store.releaseWorkingSession?.(sessionId);
    return;
  }
  const session = input.sessions.findSession(sessionId);
  if (!session) return;
  const subsidiary = readSubsidiaryId(session.metadata);
  const run = input.delegation.findRunByChildSession(sessionId);
  if (!run || run.subsidiary_id !== subsidiary) return;
  const args = JSON.parse(run.args_json) as Record<string, unknown>;
  const reference = args.taskflow_reference;
  if (typeof reference !== "string" || !store.read) return;
  const repo = run.spawn_worktree_path ?? run.spawn_cwd;
  if (!repo || await mainRepositoryKey(repo) !== await mainRepositoryKey(session.repo_path)) {
    throw new Error("Actio task ownership mismatch");
  }
  const task = await store.read(repo, reference, subsidiary);
  if (task.runtime?.delegation_run_id !== run.id) throw new Error("Actio task ownership mismatch");
  await store.setWorkingSession(repo, reference, sessionId, subsidiary, null);
  // An end event can arrive during remote I/O. Re-read lifecycle before returning.
  if (input.sessions.findSession(sessionId)?.status === "ended") {
    await store.setWorkingSession(repo, reference, null, subsidiary, sessionId);
  }
}
