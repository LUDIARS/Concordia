/**
 * Provider-neutral collaboration context for a session.
 *
 * This is intentionally not a "goal prompt". Concordia supplies coordination
 * facts: nearby sessions, branch/worktree risk, prior logs, and shared harness
 * entrypoints. The agent keeps responsibility for deriving its task from the
 * user instruction and repository state.
 */

import { basename } from "node:path";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { readSessionLogs, resolveSessionLogsDir } from "../session-logs/reader.js";
import { findConflictPeers } from "./conflict-scope.js";

export interface CollaborationContextPacket {
  session_id: string;
  repo: {
    path: string;
    origin: string | null;
    branch: string | null;
    project: string;
  };
  peers: Array<{
    id: string;
    provider: string;
    branch: string | null;
    current_task: string | null;
    last_seen_at: number;
  }>;
  conflicts: Array<{
    id: string;
    provider: string;
    branch: string | null;
    current_task: string | null;
    last_seen_at: number;
  }>;
  branches: Array<{ branch: string; count: number }>;
  recommended_worktree: {
    needed: boolean;
    reason: string;
    command: string | null;
  };
  relevant_session_logs: Array<{
    id: string;
    date: string;
    title: string;
    projects: string[];
    sections: string[];
    excerpt: string;
  }>;
  harness: {
    context: string;
    gate: string;
    intent: string;
    audit: string;
  };
  stalled_recovery: {
    policy: string;
    inject_source: string;
    guidance: string[];
  };
  cc_workflow: {
    inject_source: string;
    task_api: {
      update_todos: string;
      list_todos: string;
      list_pending: string;
    };
    rules: string[];
    interrupt_policy: string;
    completion_policy: string[];
  } | null;
  suggested_next_actions: string[];
}

export interface BuildCollaborationContextDeps {
  repo: SessionsRepo;
  session: SessionRow;
  workspaceRoots?: string[];
  maxLogs?: number;
  ccWorkflowEnabled?: boolean;
}

export async function buildCollaborationContextPacket(
  deps: BuildCollaborationContextDeps,
): Promise<CollaborationContextPacket> {
  const { repo, session } = deps;
  const peers = findConflictPeers(
    session,
    repo.listSessions({ status: "active" }),
    deps.workspaceRoots ?? [],
  );
  const conflicts = peers.filter((p) => (p.branch ?? null) === (session.branch ?? null));
  const project = basename(session.repo_path) || session.repo_origin?.split(/[\\/]/).pop() || "unknown";
  const branches = branchSummary(peers);
  const shortId = session.id.slice(0, 8);
  const command = conflicts.length
    ? `git worktree add ../${project}-${shortId} ${session.branch ?? "HEAD"}`
    : null;

  return {
    session_id: session.id,
    repo: {
      path: session.repo_path,
      origin: session.repo_origin,
      branch: session.branch,
      project,
    },
    peers: peers.map(peerSummary),
    conflicts: conflicts.map(peerSummary),
    branches,
    recommended_worktree: {
      needed: conflicts.length > 0,
      reason: conflicts.length > 0
        ? "same repo and branch are active in another session"
        : "no same-branch active peer detected",
      command,
    },
    relevant_session_logs: await relevantLogs(deps.workspaceRoots ?? [], project, deps.maxLogs ?? 5),
    harness: {
      context: "POST /v1/harness/context",
      gate: "POST /v1/harness/gate",
      intent: "POST /v1/harness/intent",
      audit: "GET /v1/harness/audit",
    },
    stalled_recovery: {
      policy: "Concordia nudges only when a session appears stalled; it does not keep a single agent running indefinitely.",
      inject_source: "auto:stall-nudge",
      guidance: [
        "re-check current diff, tests, and last error before continuing",
        "try a smaller implementation slice or alternate approach",
        "ask the user if policy, destructive action, or production impact is unclear",
        "delegate or split to a worktree when the same branch is crowded",
      ],
    },
    cc_workflow: deps.ccWorkflowEnabled ? buildCcWorkflow(session.id) : null,
    suggested_next_actions: suggestedNextActions(conflicts.length > 0),
  };
}

function buildCcWorkflow(sessionId: string): CollaborationContextPacket["cc_workflow"] {
  const encoded = encodeURIComponent(sessionId);
  return {
    inject_source: "session-start:cc-workflow",
    task_api: {
      update_todos: `POST /v1/sessions/${encoded}/event { "kind": "task_update", "payload": { "todos": [...] } }`,
      list_todos: `GET /v1/sessions/${encoded}/tasks`,
      list_pending: `GET /v1/sessions/${encoded}/pending-tasks`,
    },
    rules: [
      "Break the work into visible todos and post task_update through the Concordia API before substantive edits.",
      "Create or switch to a task branch before editing; do not work directly on main.",
      "Commit your changes when the assigned work reaches a checkpoint or is complete — never leave the working tree uncommitted (this is mandatory; Codex sessions frequently forget to commit).",
      "When implementation is complete, push the branch and open a PR.",
      "Keep task_update current as work moves between pending, in_progress, and completed.",
    ],
    interrupt_policy:
      "If the user interrupts with additional work, append it after the current queue unless the user explicitly marks it as priority.",
    completion_policy: [
      "After the PR exists, monitor CI until it is green or red.",
      "When CI is green, ask for the required final tests before merging.",
      "Merge the PR only after the requested tests pass.",
      "When CI is red, notify the session and fix the PR instead of asking for final tests.",
    ],
  };
}

function peerSummary(s: SessionRow) {
  return {
    id: s.id,
    provider: s.provider,
    branch: s.branch,
    current_task: s.current_task,
    last_seen_at: s.last_seen_at,
  };
}

function branchSummary(peers: SessionRow[]): Array<{ branch: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of peers) {
    const branch = p.branch ?? "(detached)";
    counts.set(branch, (counts.get(branch) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([branch, count]) => ({ branch, count }))
    .sort((a, b) => b.count - a.count || a.branch.localeCompare(b.branch));
}

async function relevantLogs(workspaceRoots: string[], project: string, max: number): Promise<CollaborationContextPacket["relevant_session_logs"]> {
  const dir = await resolveSessionLogsDir(workspaceRoots);
  if (!dir) return [];
  return (await readSessionLogs(dir))
    .filter((entry) => entry.projects.includes(project))
    .slice(0, max)
    .map((entry) => ({
      id: entry.id,
      date: entry.date,
      title: entry.title,
      projects: entry.projects,
      sections: entry.sections,
      excerpt: entry.excerpt,
    }));
}

function suggestedNextActions(hasConflict: boolean): string[] {
  const actions = [
    "read this context packet before starting substantive edits",
    "check active peers and avoid touching the same branch blindly",
    "load relevant session logs when resuming prior work",
  ];
  if (hasConflict) actions.push("create a separate worktree or coordinate before editing");
  return actions;
}
