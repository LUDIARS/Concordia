import { createHash } from "node:crypto";
import type { GithubIssueRunRow } from "../db/github-issue-runs-repo.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { GithubIssueTrigger } from "./issue-event.js";

/** Give an in-process invoke time to persist its correlated delegation row before declaring uncertainty. */
export const ISSUE_DISPATCH_RECOVERY_GRACE_MS = 5 * 60 * 1000;

export function issueBodySha256(body: string): string {
  return createHash("sha256").update(body.trimEnd(), "utf8").digest("hex");
}

export function issueDelegationTrigger(run: GithubIssueRunRow): string {
  return `github-issue:${run.repo_origin}#${run.issue_number}:run:${run.id}`;
}

export function legacyIssueDelegationTrigger(run: GithubIssueRunRow): string {
  return `github-issue:${run.repo_origin}#${run.issue_number}`;
}

/** Legacy correlation keys were reused by retry, so bind only a row whose immutable args match this run. */
export function isMatchingLegacyDelegation(
  run: GithubIssueRunRow,
  delegation: DelegationRunRow,
): boolean {
  if (delegation.created_at < run.created_at) return false;
  try {
    const args = JSON.parse(delegation.args_json) as Record<string, unknown>;
    return args.repo === run.repo_origin
      && args.issue_number === String(run.issue_number)
      && args.issue_url === run.issue_url
      && args.target_repo === run.repo_path
      && args.branch === run.branch;
  } catch {
    return false;
  }
}

/** A missing body may be restored only from the exact delivery recorded when the run was created. */
export function isSameQueuedIssueTrigger(
  run: GithubIssueRunRow,
  trigger: GithubIssueTrigger,
): boolean {
  return run.issue_body_sha256 !== null
    && run.repo_origin.toLowerCase() === trigger.repoOrigin.toLowerCase()
    && run.issue_number === trigger.issueNumber
    && run.label.toLowerCase() === trigger.label.toLowerCase()
    && run.actor.toLowerCase() === trigger.actor.toLowerCase()
    && run.issue_author.toLowerCase() === trigger.issueAuthor.toLowerCase()
    && run.issue_url === trigger.issueUrl
    && issueBodySha256(trigger.issueBody) === run.issue_body_sha256;
}
