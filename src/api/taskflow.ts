import { Hono } from "hono";
import type { DelegationRepo } from "../db/delegation-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TaskMdStore, TaskStatus } from "../taskflow/md-store.js";
import type { TaskflowStateStore, TaskRuntimePatch } from "../taskflow/state-store.js";
import {
  buildTaskflowOverview,
  countTaskflowRows,
  resolveTaskflowSubsidiaryId,
} from "../taskflow/overview.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import {
  matchesTaskflowOrganizationScope,
  parseTaskflowOrganizationScope,
  resolveTaskflowSubsidiary,
  type TaskflowSubsidiaryReference,
} from "../taskflow/subsidiary-scope.js";

const STATUSES: TaskStatus[] = ["pending", "delegated", "done", "cancelled"];

/** 明示 null を「消す」として通し、 未指定は変更しない。 */
function nullableStringField(
  body: Record<string, unknown> | null,
  field: "assignee" | "owner" | "source_session" | "delegation_run_id",
): Partial<TaskRuntimePatch> {
  if (!body || !(field in body)) return {};
  const value = body[field];
  if (value === null) return { [field]: null };
  return typeof value === "string" && value.trim() ? { [field]: value.trim() } : {};
}

function prNumberField(body: Record<string, unknown> | null): Partial<TaskRuntimePatch> {
  if (!body || !("pr_number" in body)) return {};
  const value = body.pr_number;
  if (value === null) return { pr_number: null };
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? { pr_number: value } : {};
}

export function taskflowRouter(input: {
  store: TaskMdStore;
  state: TaskflowStateStore;
  sessions: SessionsRepo;
  delegation: DelegationRepo;
  prs: PrRecordsRepo;
}): Hono {
  const app = new Hono();
  app.get("/tasks", async (c) => {
    const project = c.req.query("project")?.trim().toLowerCase();
    const status = c.req.query("status")?.trim() as TaskStatus | undefined;
    if (status && !STATUSES.includes(status)) return c.json({ error: "invalid_status" }, 400);
    const scope = parseTaskflowOrganizationScope({
      subsidiaryId: c.req.query("subsidiary_id"),
      headOffice: c.req.query("head_office"),
    });
    if (!scope.ok) return c.json({ error: scope.error }, 400);
    const tasks = (await input.store.scan()).map((document) => {
      const runId = document.runtime?.delegation_run_id;
      const sessionId = document.runtime?.source_session;
      return {
        document,
        subsidiaryId: resolveTaskflowSubsidiaryId({
          run: runId ? input.delegation.findRun(runId) : null,
          runtime: document.runtime ?? null,
          session: sessionId ? input.sessions.findSession(sessionId) : null,
        }),
      };
    }).filter(({ document, subsidiaryId }) => {
      if (project && document.frontmatter.project.toLowerCase() !== project) return false;
      if (status && (document.runtime?.status ?? "pending") !== status) return false;
      return matchesTaskflowOrganizationScope(subsidiaryId, scope.scope);
    }).map(({ document, subsidiaryId }) => ({
      path: input.store.relativePath(document),
      repo_path: document.repoPath,
      title: document.title,
      ...document.frontmatter,
      ...document.runtime,
      subsidiary_id: subsidiaryId,
    }));
    return c.json({ tasks });
  });
  // runtime state の唯一の書き込み口。 md へ status を書き戻さない運用なので、
  // 状態遷移 (pending→delegated→done/cancelled) はここを通す。
  app.patch("/tasks/state", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const repoPath = typeof body?.repo_path === "string" ? body.repo_path.trim() : "";
    const taskPath = typeof body?.task_path === "string" ? body.task_path.trim() : "";
    if (!repoPath || !taskPath) return c.json({ error: "repo_path and task_path are required" }, 400);
    const status = body?.status;
    if (status !== undefined && (typeof status !== "string" || !STATUSES.includes(status as TaskStatus))) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const patch: TaskRuntimePatch = {
      ...(status === undefined ? {} : { status: status as TaskStatus }),
      ...nullableStringField(body, "assignee"),
      ...nullableStringField(body, "owner"),
      ...nullableStringField(body, "source_session"),
      ...nullableStringField(body, "delegation_run_id"),
      ...prNumberField(body),
    };
    const key = { repoPath, taskPath };
    const current = input.state.find(key);
    if (!current) return c.json({ error: "not_found" }, 404);
    const ownershipTouched = !!body && (
      "subsidiary_id" in body || "source_session" in body || "delegation_run_id" in body
    );
    if (ownershipTouched) {
      const references: TaskflowSubsidiaryReference[] = [];
      const runId = patch.delegation_run_id === undefined ? current.delegation_run_id : patch.delegation_run_id;
      if (runId) {
        const run = input.delegation.findRun(runId);
        references.push({
          kind: "delegation_run",
          id: runId,
          found: !!run,
          subsidiaryId: run?.subsidiary_id ?? null,
        });
      }
      const sessionId = patch.source_session === undefined ? current.source_session : patch.source_session;
      if (sessionId) {
        const session = input.sessions.findSession(sessionId);
        references.push({
          kind: "source_session",
          id: sessionId,
          found: !!session,
          subsidiaryId: readSubsidiaryId(session?.metadata ?? null),
        });
      }
      const ownership = resolveTaskflowSubsidiary({
        explicit: body && "subsidiary_id" in body ? body.subsidiary_id : undefined,
        references,
      });
      if (!ownership.ok) {
        const statusCode = ownership.error === "conflicting_subsidiary_ownership" ? 409 : 400;
        return c.json({ error: ownership.error }, statusCode);
      }
      if (ownership.subsidiaryId !== undefined) patch.subsidiary_id = ownership.subsidiaryId;
    }
    if (!input.state.update(key, patch)) {
      return c.json({ error: "no_changes" }, 404);
    }
    return c.json({ ok: true, state: input.state.find(key) });
  });
  app.get("/overview", async (c) => {
    const project = c.req.query("project")?.trim().toLowerCase();
    const status = c.req.query("status")?.trim() as TaskStatus | undefined;
    const teamId = c.req.query("team_id")?.trim();
    if (status && !STATUSES.includes(status)) return c.json({ error: "invalid_status" }, 400);
    const scope = parseTaskflowOrganizationScope({
      subsidiaryId: c.req.query("subsidiary_id"),
      headOffice: c.req.query("head_office"),
    });
    if (!scope.ok) return c.json({ error: scope.error }, 400);
    const overview = buildTaskflowOverview({
      documents: await input.store.scan(),
      relativePath: (document) => input.store.relativePath(document),
      sessions: input.sessions.listSessions({}),
      runs: input.delegation.recentRuns(1000),
      prs: input.prs.list({ limit: 500 }),
    });
    const tasks = overview.tasks.filter((task) => {
      if (project && task.project.toLowerCase() !== project) return false;
      if (teamId && task.team_id !== teamId) return false;
      if (!matchesTaskflowOrganizationScope(task.subsidiary_id, scope.scope)) return false;
      return !status || task.status === status;
    });
    return c.json({
      ...overview,
      counts: countTaskflowRows(tasks),
      tasks,
    });
  });
  return app;
}
