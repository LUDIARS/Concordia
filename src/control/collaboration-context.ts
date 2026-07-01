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
  suggested_next_actions: string[];
}

export interface BuildCollaborationContextDeps {
  repo: SessionsRepo;
  session: SessionRow;
  workspaceRoots?: string[];
  maxLogs?: number;
}

export function buildCollaborationContextPacket(
  deps: BuildCollaborationContextDeps,
): CollaborationContextPacket {
  const { repo, session } = deps;
  const peers = repo.findActivePeers(session.repo_path, session.id);
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
    relevant_session_logs: relevantLogs(deps.workspaceRoots ?? [], project, deps.maxLogs ?? 5),
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
    suggested_next_actions: suggestedNextActions(conflicts.length > 0),
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

function relevantLogs(workspaceRoots: string[], project: string, max: number): CollaborationContextPacket["relevant_session_logs"] {
  const dir = resolveSessionLogsDir(workspaceRoots);
  if (!dir) return [];
  return readSessionLogs(dir)
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
