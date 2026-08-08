import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { PrCiStatus, PrRecordRow, PrState } from "../db/pr-records-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { TaskDocument, TaskStatus } from "./md-store.js";

export interface TaskflowOverviewRow {
  path: string;
  repo_path: string;
  title: string;
  task: string;
  project: string;
  kind: string;
  status: TaskStatus;
  created: string;
  assignee: string | null;
  source_session: string | null;
  session_status: SessionRow["status"] | null;
  /** 委託の親 (委託元 = このタスクを管理するセッション)。 run が無ければ null。 */
  parent_session_id: string | null;
  /** 委託の子 (実装担当)。 run が無ければ null。 */
  child_session_id: string | null;
  delegation_run_id: string | null;
  delegation_status: DelegationRunRow["status"] | null;
  pr: {
    number: number;
    title: string;
    url: string | null;
    state: PrState;
  } | null;
  ci_status: PrCiStatus;
}

export interface TaskflowOverview {
  generated_at: number;
  counts: {
    total: number;
    pending: number;
    delegated: number;
    done: number;
    cancelled: number;
    ci_failure: number;
    ci_pending: number;
  };
  tasks: TaskflowOverviewRow[];
}

export function countTaskflowRows(tasks: readonly TaskflowOverviewRow[]): TaskflowOverview["counts"] {
  return {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === "pending").length,
    delegated: tasks.filter((task) => task.status === "delegated").length,
    done: tasks.filter((task) => task.status === "done").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
    ci_failure: tasks.filter((task) => task.ci_status === "failure").length,
    ci_pending: tasks.filter((task) => task.ci_status === "pending").length,
  };
}

export function buildTaskflowOverview(input: {
  documents: readonly TaskDocument[];
  relativePath: (document: TaskDocument) => string;
  sessions: readonly SessionRow[];
  runs: readonly DelegationRunRow[];
  prs: readonly PrRecordRow[];
  now?: number;
}): TaskflowOverview {
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  const runsById = new Map(input.runs.map((run) => [run.id, run]));

  const tasks = input.documents.map((document): TaskflowOverviewRow => {
    const fm = document.frontmatter;
    const runtime = document.runtime ?? defaultRuntime();
    const explicitSessionId = runtime.source_session;
    const explicitRunId = runtime.delegation_run_id;
    // run の推定は「child 一致 → parent 一致」の決定的順序にする。 混在 find だと
    // runs の並び次第で同じタスクが親に付いたり子に付いたりして親子表示が不定になる。
    const run = (explicitRunId ? runsById.get(explicitRunId) : null)
      ?? input.runs.find((candidate) => !!explicitSessionId && candidate.child_session_id === explicitSessionId)
      ?? input.runs.find((candidate) => !!explicitSessionId && candidate.parent_session_id === explicitSessionId)
      ?? null;
    const sessionId = explicitSessionId ?? run?.child_session_id ?? run?.parent_session_id ?? null;
    const session = sessionId ? sessionsById.get(sessionId) ?? null : null;
    const pr = resolveTaskPr(document, session, sessionId, input.prs);
    return {
      path: input.relativePath(document),
      repo_path: document.repoPath,
      title: document.title,
      task: fm.task,
      project: fm.project,
      kind: fm.kind,
      status: runtime.status,
      created: fm.created,
      assignee: resolveAssignee(runtime, session, run, pr),
      source_session: sessionId,
      session_status: session?.status ?? null,
      parent_session_id: run?.parent_session_id ?? null,
      child_session_id: run?.child_session_id ?? null,
      delegation_run_id: run?.id ?? explicitRunId ?? null,
      delegation_status: run?.status ?? null,
      pr: pr ? { number: pr.number, title: pr.title, url: pr.url, state: pr.state } : null,
      ci_status: pr?.ci_status ?? "unknown",
    };
  }).sort(compareRows);

  return {
    generated_at: input.now ?? Math.floor(Date.now() / 1000),
    counts: countTaskflowRows(tasks),
    tasks,
  };
}

function resolveTaskPr(
  document: TaskDocument,
  session: SessionRow | null,
  sessionId: string | null,
  prs: readonly PrRecordRow[],
): PrRecordRow | null {
    const explicitNumber = document.runtime?.pr_number ?? null;
  if (explicitNumber !== null) {
    const repoMatches = prs.filter((pr) => sameRepo(document, session, pr));
    return repoMatches.find((pr) => pr.number === explicitNumber)
      ?? prs.find((pr) => pr.number === explicitNumber)
      ?? null;
  }
  if (sessionId) {
    const authored = prs.find((pr) => pr.author_session_id === sessionId);
    if (authored) return authored;
  }
  if (session?.branch) {
    return prs.find((pr) => pr.head_branch === session.branch && sameRepo(document, session, pr)) ?? null;
  }
  return null;
}

function sameRepo(document: TaskDocument, session: SessionRow | null, pr: PrRecordRow): boolean {
  if (session?.repo_origin && pr.repo_origin === session.repo_origin) return true;
  if (pr.repo_path && normalizePath(pr.repo_path) === normalizePath(document.repoPath)) return true;
  return pr.repo_origin.toLowerCase().endsWith(`/${document.frontmatter.project.toLowerCase()}`);
}

function resolveAssignee(
  runtime: { assignee: string | null; owner: string | null },
  session: SessionRow | null,
  run: DelegationRunRow | null,
  pr: PrRecordRow | null,
): string | null {
  const explicit = runtime.assignee ?? runtime.owner;
  if (explicit) return explicit;
  const metadata = parseMetadata(session?.metadata);
  return stringValue(metadata.role_label)
    ?? stringValue(metadata.delegation_call_name)
    ?? run?.call_name
    ?? session?.provider
    ?? null;
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultRuntime(): { status: TaskStatus; source_session: string | null; assignee: string | null; owner: string | null; delegation_run_id: string | null; pr_number: number | null } {
  return { status: "pending", source_session: null, assignee: null, owner: null, delegation_run_id: null, pr_number: null };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function compareRows(a: TaskflowOverviewRow, b: TaskflowOverviewRow): number {
  const statusOrder: Record<TaskStatus, number> = { delegated: 0, pending: 1, done: 2, cancelled: 3 };
  const ciOrder: Record<PrCiStatus, number> = { failure: 0, pending: 1, unknown: 2, success: 3 };
  return statusOrder[a.status] - statusOrder[b.status]
    || ciOrder[a.ci_status] - ciOrder[b.ci_status]
    || a.project.localeCompare(b.project)
    || a.title.localeCompare(b.title);
}
