/** @implements CC-TASK-LINKED-FOLLOWUP — Cc owns references, Actio owns task state. */
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { ACTIO_REFERENCE } from "../taskflow/actio-store.js";
import type { TaskStore } from "../taskflow/store.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("work/task-links");

export const SESSION_TASK_LINKS_KEY = "cc_task_links";
const MAX_LINKS = 16;

export interface SessionTaskLink {
  instruction_ref: string;
  task_reference: string;
  linked_at: number;
  repo_path: string;
  repo_origin: string | null;
  target_project: string | null;
  subsidiary_id: string | null;
}

/** Why a linked task state is unknown; never swallowed (spec/feature/task-linked-followup.md). */
export type LinkedTaskUnknownReason = "not_found" | "task_out_of_scope" | "task_unavailable" | "status_unrecognized";

export interface LinkedTaskView extends SessionTaskLink {
  status: "open" | "in_progress" | "blocked" | "done" | "cancelled" | "unknown";
  state: "current" | "unknown";
  reason?: LinkedTaskUnknownReason;
}

const ACTIO_STATUSES = new Set(["open", "in_progress", "blocked", "done", "cancelled"]);

function scopedTo(link: SessionTaskLink, session: SessionRow): boolean {
  if (link.subsidiary_id !== readSubsidiaryId(session.metadata)) return false;
  if (!!link.repo_origin !== !!session.repo_origin) return false;
  if (!!link.target_project !== !!session.target_project) return false;
  if (link.repo_origin && session.repo_origin && link.repo_origin.toLowerCase() !== session.repo_origin.toLowerCase()) return false;
  if (link.target_project && session.target_project && link.target_project !== session.target_project) return false;
  if (link.repo_origin || link.target_project) return true;
  return link.repo_path.replace(/\\/g, "/").toLowerCase()
    === session.repo_path.replace(/\\/g, "/").toLowerCase();
}

function taskReadFailure(error: unknown): "not_found" | "task_out_of_scope" | "task_unavailable" {
  if (!(error instanceof Error)) return "task_unavailable";
  if (/^Actio task request rejected \(404\)$/.test(error.message)) return "not_found";
  if (/^Actio task request rejected \((401|403)\)$/.test(error.message)
    || error.message === "Actio task ownership mismatch"
    || error.message === "Actio task identity mismatch"
    || error.message === "Actio task team access mismatch"
    || error.message === "Actio task project binding missing or ambiguous") return "task_out_of_scope";
  return "task_unavailable";
}

function unknownView(link: SessionTaskLink, reason: LinkedTaskUnknownReason, detail: string): LinkedTaskView {
  // Error messages here are fixed strings from the Actio adapter; no task body or credential.
  log.warn({ task_reference: link.task_reference, reason, detail: detail.slice(0, 200) }, "linked task state unavailable");
  return { ...link, status: "unknown", state: "unknown", reason };
}

/** 関連付け・表示は参照専用の読み込みを優先する (旧来タスクも対象)。無い store は従来の read。 */
function referenceReader(tasks: Pick<TaskStore, "read" | "readReference">): TaskStore["read"] {
  return tasks.readReference?.bind(tasks) ?? tasks.read?.bind(tasks);
}

export function readSessionTaskLinks(metadata: string | null): SessionTaskLink[] {
  try {
    const parsed = JSON.parse(metadata ?? "{}") as Record<string, unknown>;
    const value = parsed[SESSION_TASK_LINKS_KEY];
    if (!Array.isArray(value)) return [];
    return value.filter((link): link is SessionTaskLink => typeof link === "object" && link !== null
      && typeof link.instruction_ref === "string" && typeof link.task_reference === "string"
      && ACTIO_REFERENCE.test(link.task_reference) && Number.isFinite(link.linked_at)
      && typeof link.repo_path === "string"
      && (typeof link.repo_origin === "string" || link.repo_origin === null)
      && (typeof link.target_project === "string" || link.target_project === null)
      && (typeof link.subsidiary_id === "string" || link.subsidiary_id === null)).slice(0, MAX_LINKS);
  } catch { return []; }
}

function sameBinding(before: SessionRow, after: SessionRow | null): boolean {
  return !!after && after.status === "active" && before.status === "active"
    && after.repo_path === before.repo_path && after.repo_origin === before.repo_origin
    && after.branch === before.branch && after.target_project === before.target_project
    && readSubsidiaryId(after.metadata) === readSubsidiaryId(before.metadata);
}

export async function addSessionTaskLink(input: {
  sessions: Pick<SessionsRepo, "findSession" | "updateMetadata">;
  tasks: Pick<TaskStore, "read" | "readReference">;
  sessionId: string;
  instructionRef: string;
  taskReference: string;
  now?: () => number;
}): Promise<{ kind: "linked" | "existing"; link: SessionTaskLink } | { kind: "not_found" | "stale_binding" | "limit" | "task_out_of_scope" | "task_unavailable" }> {
  const { sessions, tasks, sessionId, instructionRef, taskReference } = input;
  if (!instructionRef.trim() || instructionRef.length > 256 || !ACTIO_REFERENCE.test(taskReference)) {
    throw new Error("invalid_task_link");
  }
  const before = sessions.findSession(sessionId);
  if (!before || before.status !== "active") return { kind: "not_found" };
  const allPrior = readSessionTaskLinks(before.metadata);
  const prior = allPrior.filter((link) => scopedTo(link, before));
  const existing = prior.find((link) => link.instruction_ref === instructionRef && link.task_reference === taskReference);
  if (existing) return { kind: "existing", link: existing };
  if (allPrior.length >= MAX_LINKS) return { kind: "limit" };
  const readTask = referenceReader(tasks);
  if (!readTask) return { kind: "task_unavailable" };
  let taskRepoPath: string;
  try {
    const task = await readTask(before.repo_path, taskReference, readSubsidiaryId(before.metadata));
    if (task.path !== taskReference || !task.repoPath) return { kind: "task_out_of_scope" };
    taskRepoPath = task.repoPath;
  } catch (error) {
    if (!sameBinding(before, sessions.findSession(sessionId))) return { kind: "stale_binding" };
    return { kind: taskReadFailure(error) };
  }
  const latest = sessions.findSession(sessionId);
  if (!sameBinding(before, latest)) return { kind: "stale_binding" };
  const allLatestLinks = readSessionTaskLinks(latest!.metadata);
  const latestLinks = allLatestLinks.filter((item) => scopedTo(item, latest!));
  const duplicate = latestLinks.find((link) => link.instruction_ref === instructionRef && link.task_reference === taskReference);
  if (duplicate) return { kind: "existing", link: duplicate };
  if (allLatestLinks.length >= MAX_LINKS) return { kind: "limit" };
  const link = { instruction_ref: instructionRef, task_reference: taskReference, linked_at: input.now?.() ?? Date.now(),
    repo_path: taskRepoPath, repo_origin: before.repo_origin, target_project: before.target_project ?? null,
    subsidiary_id: readSubsidiaryId(before.metadata) };
  sessions.updateMetadata(sessionId, (metadata) => ({ ...metadata,
    [SESSION_TASK_LINKS_KEY]: [...allLatestLinks, link],
  }));
  return { kind: "linked", link };
}

export async function readLinkedTaskViews(input: {
  sessions: Pick<SessionsRepo, "findSession">;
  tasks: Pick<TaskStore, "read" | "readReference">;
  sessionId: string;
}): Promise<{ kind: "current" | "stale_binding" | "not_found"; links: LinkedTaskView[] }> {
  const before = input.sessions.findSession(input.sessionId);
  if (!before) return { kind: "not_found", links: [] };
  const links = readSessionTaskLinks(before.metadata).filter((link) => scopedTo(link, before));
  const result: LinkedTaskView[] = [];
  for (const link of links) {
    try {
      const task = await referenceReader(input.tasks)?.(before.repo_path, link.task_reference, readSubsidiaryId(before.metadata));
      if (!task) throw new Error("task_read_unavailable");
      const rawStatus = task.frontmatter.actio_status;
      if (task.repoPath !== link.repo_path) {
        result.push(unknownView(link, "task_out_of_scope", "task repository differs from the linked repository"));
      } else if (typeof rawStatus === "string" && ACTIO_STATUSES.has(rawStatus)) {
        result.push({ ...link, status: rawStatus as LinkedTaskView["status"], state: "current" });
      } else {
        result.push(unknownView(link, "status_unrecognized", `unrecognized Actio status ${String(rawStatus)}`));
      }
    } catch (error) {
      result.push(unknownView(link, taskReadFailure(error), error instanceof Error ? error.message : "non-error thrown"));
    }
  }
  if (!sameBinding(before, input.sessions.findSession(input.sessionId))) {
    return { kind: "stale_binding", links: [] };
  }
  return { kind: "current", links: result };
}
