export type BindStage = "session" | "workspace" | "repository" | "project" | "persistence";
export type BindReason = "session_not_found" | "session_inactive" | "invalid_task" | "workspace_denied"
  | "invalid_cwd" | "git_unavailable" | "git_timeout" | "git_ownership" | "git_not_repository"
  | "git_failed" | "unnamed_branch" | "project_not_registered" | "project_ambiguous"
  | "identity_unavailable" | "stale_session" | "persistence_failed" | "unexpected_failure";

/** Only fixed vocabulary crosses the public error boundary; cause stays private. */
export class ImplementationBindFailure extends Error {
  constructor(readonly stage: BindStage, readonly reason: BindReason, cause?: unknown) {
    super(`implementation bind: ${stage}/${reason}`, { cause });
    this.name = "ImplementationBindFailure";
  }
}

export interface BindFailureResponse {
  error: "implementation_bind_failed";
  stage: BindStage;
  reason: BindReason;
  binding: "unchanged";
  guidance: string;
}

export function bindFailureResponse(error: unknown): BindFailureResponse {
  const failure = error instanceof ImplementationBindFailure
    ? error : new ImplementationBindFailure("persistence", "unexpected_failure");
  return { error: "implementation_bind_failed", stage: failure.stage, reason: failure.reason,
    binding: "unchanged" as const,
    guidance: "Inspect the current session binding and the reported prerequisite before retrying the same checkout." };
}
