import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { InvokeInput } from "../delegation/contracts.js";
import type { InvokeResult } from "../delegation/service.js";
import type { DeskRequest } from "./desk-request-policy.js";
import type { DeskProject } from "./routing-policy.js";

export interface DeskDelegationDeps {
  findRun(trigger: string): DelegationRunRow | null;
  findRunByChild(sessionId: string): DelegationRunRow | null;
  invoke(input: InvokeInput): Promise<InvokeResult>;
  childStopped(sessionId: string): boolean;
}

export interface DeskDelegationRun {
  id: string;
  childSessionId: string | null;
  state: "active" | "completed" | "retryable" | "failed";
  isRetry: boolean;
}

function trigger(requestId: string, retry: boolean): string {
  return `desk-request:${requestId}:${retry ? "retry" : "initial"}`;
}

export function createDeskDelegationPorts(deps: DeskDelegationDeps) {
  const read = (requestId: string) => deps.findRun(trigger(requestId, true)) ?? deps.findRun(trigger(requestId, false));
  return {
    requestForChildSession(sessionId: string): string | null {
      const run = deps.findRunByChild(sessionId);
      return /^desk-request:([^:]+):(?:initial|retry)$/u.exec(run?.triggered_by ?? "")?.[1] ?? null;
    },
    delegationRun(requestId: string): DeskDelegationRun | null {
      const run = read(requestId);
      if (!run) return null;
      const failed = run.status === "failed" || run.status === "spawn_failed";
      const isRetry = run.triggered_by === trigger(requestId, true);
      const childStopped = run.child_session_id ? deps.childStopped(run.child_session_id) : run.status === "spawn_failed" && !run.spawn_pid;
      return {
        id: run.id, childSessionId: run.child_session_id,
        state: run.status === "completed" ? "completed" : failed ? (childStopped ? "retryable" : "failed") : "active",
        isRetry,
      };
    },
    async delegate(request: DeskRequest, project: DeskProject, retry: boolean): Promise<boolean> {
      if (!request.task_reference || !request.session_id) return false;
      const previous = retry ? read(request.id) : null;
      const outcome = await deps.invoke({
        call_name: "sol", cwd: project.repoPath, project: project.code, parent_session_id: request.session_id,
        args: { target_repo: project.repoPath, taskflow_reference: request.task_reference,
          task: [
            retry ? "前回の委託の状態と既存の作業を確認して、同じ Actio タスクを続けてください。" : "依頼窓口の既存 Actio タスクを進めてください。",
            "依頼の完了条件を満たしたら、既存の taskflow の状態更新で Actio に結果を反映してください。",
          ].join("\n") },
        triggered_by: trigger(request.id, retry), spawn: true, worktree: true,
        ...(previous?.spawn_branch ? { branch: previous.spawn_branch } : {}),
      });
      return outcome.ok;
    },
  };
}
