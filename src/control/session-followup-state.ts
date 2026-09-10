/** @implements spec/feature/shared-startup-context.md — state-dependent periodic guidance */
import { fileURLToPath } from "node:url";
import { DELEGATION_RUN_STATUSES } from "../db/delegation-repo.js";
import type { ProjectStartupWorkflow } from "./project-startup-workflow.js";

export interface SessionFollowupSnapshot {
  workflow: ProjectStartupWorkflow;
  tasks: readonly { status: string }[];
  /** Newest first; historical failures must not override a later completed run. */
  delegations: readonly { status: string }[];
  prs: readonly { status: string; checkStatus: string }[];
}

export type SessionFollowupState = "task-active" | "delegation-wait" | "review-needed" | "review-wait"
  | "review-failed" | "merge-confirmation" | "completed" | "unknown";

/**
 * Every delegation status that means "the child may still be working".
 *
 * Derived from DELEGATION_RUN_STATUSES minus the terminal ones so that adding a
 * status upstream cannot silently drop a live child out of `delegation-wait` —
 * that is precisely the state whose whole purpose is to stop the parent from
 * re-implementing work a running child already owns.
 */
const TERMINAL_DELEGATION_STATUSES = new Set<string>(["completed", "failed", "spawn_failed"]);
const IN_FLIGHT_DELEGATION_STATUSES = new Set<string>(
  DELEGATION_RUN_STATUSES.filter((status) => !TERMINAL_DELEGATION_STATUSES.has(status)),
);

export function selectSessionFollowupState(snapshot: SessionFollowupSnapshot): SessionFollowupState {
  const open = snapshot.prs.filter((pr) => pr.status === "open");
  if (open.some((pr) => ["failed", "action_required"].includes(pr.checkStatus))) return "review-failed";
  if (open.some((pr) => pr.checkStatus === "test_ok")) return "merge-confirmation";
  if (open.length) return "review-wait";
  if (snapshot.delegations.some((run) => IN_FLIGHT_DELEGATION_STATUSES.has(run.status))) return "delegation-wait";
  if (snapshot.tasks.some((task) => task.status !== "completed")) return "task-active";
  if (snapshot.prs.some((pr) => pr.status === "merged")) return "completed";
  if (snapshot.delegations[0]?.status === "failed") return "review-failed";
  if (snapshot.tasks.length || snapshot.delegations[0]?.status === "completed") return "review-needed";
  return "unknown";
}

export function renderSessionFollowup(snapshot?: SessionFollowupSnapshot): string {
  const state = snapshot ? selectSessionFollowupState(snapshot) : "unknown";
  const skill = fileURLToPath(new URL("../../skills/session-followup/SKILL.md", import.meta.url));
  return [
    "[自動確認] Cc の作業状態に応じた確認です。",
    `workflow=${snapshot?.workflow ?? "unknown"}; state=${state}`,
    `固定手順: ${JSON.stringify(skill)} の該当stateだけ読んでください。`,
    "これは終了指示ではありません。人間の確認待ちは維持し、自動でsession-end・push・merge・テストを実行しないでください。",
  ].join("\n");
}
