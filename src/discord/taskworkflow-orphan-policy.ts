/** @implements spec/feature/taskworkflow-orphan-reconciliation.md CC-DISCORD-TASK-ORPHAN-01 */
export const TASKWORKFLOW_ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface TaskWorkflowStarterIdentity {
  sessionId: string;
  runId: string;
}

export function readTaskWorkflowStarter(content: string): TaskWorkflowStarterIdentity | null {
  const sessionId = /^\*\*TaskWorkflow\*\* `([a-zA-Z0-9_-]{1,100})`(?:\r?\n|$)/.exec(content)?.[1];
  const runId = /^\*\*Delegation run\*\* `([a-zA-Z0-9_-]{1,100})`\r?$/m.exec(content)?.[1];
  if (!sessionId || !runId || !/^\*\*(?:Repo|Repository)\*\* /m.test(content)) return null;
  return { sessionId, runId };
}

/** Outcome is deliberately not an input: archiving a vanished surface is not task completion. */
export function shouldArchiveTaskWorkflowOrphan(input: {
  trustedStarter: boolean;
  identity: TaskWorkflowStarterIdentity | null;
  runChildSessionId: string | null;
  sessionStatus: string | null;
  hasChannelBinding: boolean;
  hasSessionBinding: boolean;
  createdAtMs: number | null;
  nowMs: number;
}): boolean {
  return input.trustedStarter
    && input.identity !== null
    && input.runChildSessionId === input.identity.sessionId
    && (input.sessionStatus === null || input.sessionStatus === "ended" || input.sessionStatus === "lost")
    && !input.hasChannelBinding
    && !input.hasSessionBinding
    && input.createdAtMs !== null
    && Number.isFinite(input.createdAtMs)
    && input.nowMs - input.createdAtMs >= TASKWORKFLOW_ORPHAN_GRACE_MS;
}
