import { basename } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  ProjectCodeConflictError,
  type ProjectCodeRow,
  type ProjectCodesRepo,
} from "../db/project-codes-repo.js";
import { inspectImplementationRepo, isWithinWorkspace } from "../implementation-tools/repo-context.js";
import type {
  RevisorRepositoryAdmin,
  RevisorRepositoryRecord,
} from "../pr/revisor-repository-client.js";

// @implements spec/feature/project-code-registry.md — 操作面 / 管理 UI

type ProjectCodeResponseRow = Pick<ProjectCodeRow, "code" | "project" | "repo_path">;

const RegisterSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/),
  repo_path: z.string().trim().min(1).max(1_000),
  added_by: z.string().trim().min(1).max(200).default("api"),
}).strict();

const UpdateSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/).optional(),
  project: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
  repo_path: z.string().trim().min(1).max(1_000).optional(),
  repo_origin: z.string().trim().min(1).max(1_000).nullable().optional(),
}).strict();

const AssignTeamsSchema = z.object({
  team_ids: z.array(z.string().trim().min(1).max(200)).max(200),
}).strict();
const AssignSubsidiariesSchema = z.object({
  subsidiary_ids: z.array(z.string().trim().min(1).max(200)).max(200),
}).strict();
const RevisorWorkflowSchema = z.object({ workflow: z.enum(["revisor", "github"]) }).strict();

export interface ProjectCodesRouterDeps {
  repo: ProjectCodesRepo;
  resolveWorkspaceRoots: () => string[];
  /** 所属チーム表示/変更 (未注入なら teams 欄は常に空 / 変更 503)。 */
  teams?: {
    list: () => Array<{ id: string; name: string }>;
    find: (id: string) => { id: string; name: string } | null;
    listRepoAssignments: () => Array<{ team_id: string; repo_origin: string }>;
    assignRepoToTeams: (repoOrigin: string, teamIds: readonly string[]) => void;
    moveRepoAssignment: (fromOrigin: string, toOrigin: string) => void;
  };
  /** 関係会社表示/変更 (未注入なら subsidiaries 欄は常に空 / 変更 503)。 */
  subsidiaries?: {
    list: () => Array<{ id: string; name: string; display_name: string }>;
    find: (id: string) => { id: string } | null;
    listProjectAssignments: () => Array<{ subsidiary_id: string; project: string }>;
    assignProjectToSubsidiaries: (project: string, subsidiaryIds: readonly string[]) => void;
    moveProjectAssignment: (fromProject: string, toProject: string) => void;
  };
  /** Revisor の登録リポと workflow (Rv モード) の read/update。 未注入なら欄は unknown。 */
  revisor?: RevisorRepositoryAdmin;
  /**
   * git 検査の差し替え口 (テスト用)。 vi.mock は isolate:false の registry 共有で
   * ロード順に依存して効かないことがあるため、 module mock でなく DI で差し替える。
   */
  repoContext?: {
    inspectImplementationRepo: typeof inspectImplementationRepo;
    isWithinWorkspace: typeof isWithinWorkspace;
  };
}

export function projectCodesRouter(deps: ProjectCodesRouterDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = deps.repo.list();
    return c.json({
      source: "concordia-db",
      project_codes: rows.map(toResponseRow),
      categories: rows.length === 0
        ? []
        : [{ name: "Concordia registry", entries: rows.map((row) => [row.code, row.project]) }],
    });
  });

  /**
   * 管理 UI 用の全項目ビュー。 通常の GET と違い repo_origin (GitHub URL) や監査項目、
   * 所属チーム/会社、 Revisor workflow を含む — loopback の管理面だけが読む前提。
   */
  app.get("/admin", async (c) => {
    const rows = deps.repo.list();
    const teamsByRepo = groupAssignments(
      deps.teams?.listRepoAssignments() ?? [],
      (row) => row.repo_origin.toLowerCase(),
      (row) => row.team_id,
    );
    const subsidiariesByProject = groupAssignments(
      deps.subsidiaries?.listProjectAssignments() ?? [],
      (row) => row.project.toLowerCase(),
      (row) => row.subsidiary_id,
    );
    const teams = deps.teams?.list() ?? [];
    const teamName = new Map(teams.map((team) => [team.id, team.name]));
    const subsidiaries = (deps.subsidiaries?.list() ?? [])
      .map((row) => ({ id: row.id, name: row.display_name || row.name }));
    const subsidiaryName = new Map(subsidiaries.map((row) => [row.id, row.name]));
    const revisorRepos = await listRevisorRepositories(deps);

    return c.json({
      entries: rows.map((row) => {
        const teamIds = row.repo_origin ? teamsByRepo.get(row.repo_origin.toLowerCase()) ?? [] : [];
        const subsidiaryIds = subsidiariesByProject.get(row.project.toLowerCase()) ?? [];
        const revisorEntry = revisorRepos.list
          ? findRevisorRecord(revisorRepos.list, row) ?? null
          : undefined;
        return {
          code: row.code,
          project: row.project,
          repo_path: row.repo_path,
          repo_origin: row.repo_origin,
          added_by: row.added_by,
          updated_at: row.updated_at,
          teams: teamIds.map((id) => ({ id, name: teamName.get(id) ?? id })),
          subsidiaries: subsidiaryIds.map((id) => ({ id, name: subsidiaryName.get(id) ?? id })),
          // undefined = Revisor に問い合わせできなかった (unknown)。 null = 未登録。
          revisor: revisorEntry === undefined
            ? null
            : revisorEntry === null
              ? { registered: false, workflow: null }
              : { registered: true, workflow: revisorEntry.workflow ?? "revisor" },
        };
      }),
      teams,
      subsidiaries,
      revisor_available: revisorRepos.list !== null,
    });
  });

  app.post("/", async (c) => {
    const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_project_code", detail: parsed.error.flatten() }, 400);

    const inspected = await inspectWorkspaceRepo(deps, parsed.data.repo_path);
    if ("error" in inspected) return c.json({ error: inspected.error }, 400);

    try {
      const result = deps.repo.register({
        code: parsed.data.code,
        project: basename(inspected.repoPath),
        repoPath: inspected.repoPath,
        repoOrigin: inspected.repoOrigin,
        addedBy: parsed.data.added_by,
      });
      return c.json({ project_code: toResponseRow(result.row), created: result.created }, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ProjectCodeConflictError) {
        return c.json({ error: "project_code_conflict", field: error.field }, 409);
      }
      throw error;
    }
  });

  app.patch("/:code", async (c) => {
    const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_project_code", detail: parsed.error.flatten() }, 400);

    const current = deps.repo.findByCode(c.req.param("code"));
    if (!current) return c.json({ error: "project_code_not_found" }, 404);
    const patch: Parameters<ProjectCodesRepo["update"]>[1] = {
      code: parsed.data.code,
      project: parsed.data.project,
      repoOrigin: parsed.data.repo_origin,
    };
    if (parsed.data.repo_path !== undefined) {
      // repo_path の変更は登録時と同じ検査 (workspace 内 + git repo) を通し、
      // project 名と origin は明示指定が無ければ実リポから取り直す。
      const inspected = await inspectWorkspaceRepo(deps, parsed.data.repo_path);
      if ("error" in inspected) return c.json({ error: inspected.error }, 400);
      patch.repoPath = inspected.repoPath;
      if (patch.project === undefined) patch.project = basename(inspected.repoPath);
      if (patch.repoOrigin === undefined) patch.repoOrigin = inspected.repoOrigin;
    }

    try {
      const row = deps.repo.update(c.req.param("code"), patch);
      if (!row) return c.json({ error: "project_code_not_found" }, 404);
      if (deps.teams && current.repo_origin
        && current.repo_origin.toLowerCase() !== row.repo_origin?.toLowerCase()) {
        if (row.repo_origin) deps.teams.moveRepoAssignment(current.repo_origin, row.repo_origin);
        else deps.teams.assignRepoToTeams(current.repo_origin, []);
      }
      if (deps.subsidiaries && current.project.toLowerCase() !== row.project.toLowerCase()) {
        deps.subsidiaries.moveProjectAssignment(current.project, row.project);
      }
      return c.json({ project_code: toAdminRow(row) });
    } catch (error) {
      if (error instanceof ProjectCodeConflictError) {
        return c.json({ error: "project_code_conflict", field: error.field }, 409);
      }
      throw error;
    }
  });

  app.delete("/:code", (c) => {
    const current = deps.repo.findByCode(c.req.param("code"));
    if (!current) return c.json({ error: "project_code_not_found" }, 404);
    const removed = deps.repo.remove(current.code);
    if (!removed) return c.json({ error: "project_code_not_found" }, 404);
    if (deps.teams && current.repo_origin) deps.teams.assignRepoToTeams(current.repo_origin, []);
    if (deps.subsidiaries) deps.subsidiaries.assignProjectToSubsidiaries(current.project, []);
    return c.json({ ok: true });
  });

  app.put("/:code/team", async (c) => {
    if (!deps.teams) return c.json({ error: "team_registry_unavailable" }, 503);
    const parsed = AssignTeamsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_team_assignment" }, 400);
    const row = deps.repo.findByCode(c.req.param("code"));
    if (!row) return c.json({ error: "project_code_not_found" }, 404);
    // チーム所属は repo_origin (GitHub URL) で持つ (team_repos)。 origin の無い登録は
    // 紐付け先が無いので、 先に GitHub URL を設定してもらう。
    if (!row.repo_origin) return c.json({ error: "repo_origin_required_for_team" }, 400);
    const teamIds = [...new Set(parsed.data.team_ids)];
    if (teamIds.some((id) => !deps.teams!.find(id))) {
      return c.json({ error: "team_not_found" }, 404);
    }
    deps.teams.assignRepoToTeams(row.repo_origin, teamIds);
    return c.json({ ok: true, team_ids: teamIds });
  });

  app.put("/:code/subsidiary", async (c) => {
    if (!deps.subsidiaries) return c.json({ error: "subsidiary_registry_unavailable" }, 503);
    const parsed = AssignSubsidiariesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_subsidiary_assignment" }, 400);
    const row = deps.repo.findByCode(c.req.param("code"));
    if (!row) return c.json({ error: "project_code_not_found" }, 404);
    const subsidiaryIds = [...new Set(parsed.data.subsidiary_ids)];
    if (subsidiaryIds.some((id) => !deps.subsidiaries!.find(id))) {
      return c.json({ error: "subsidiary_not_found" }, 404);
    }
    deps.subsidiaries.assignProjectToSubsidiaries(row.project, subsidiaryIds);
    return c.json({ ok: true, subsidiary_ids: subsidiaryIds });
  });

  app.put("/:code/revisor-workflow", async (c) => {
    if (!deps.revisor) return c.json({ error: "revisor_unavailable" }, 503);
    const parsed = RevisorWorkflowSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_revisor_workflow" }, 400);
    const row = deps.repo.findByCode(c.req.param("code"));
    if (!row) return c.json({ error: "project_code_not_found" }, 404);

    const repos = await listRevisorRepositories(deps);
    if (!repos.list) return c.json({ error: "revisor_unreachable" }, 502);
    const record = findRevisorRecord(repos.list, row);
    if (!record) {
      // 新規登録には test_cases (登録テスト) が要る。 workflow だけの口から
      // テスト無し登録を作らない — Revisor 側の登録フローで登録してもらう。
      return c.json({ error: "revisor_not_registered" }, 409);
    }

    // Revisor の登録は upsert (merge)。 既存 record を round-trip し workflow だけ変える。
    const updated = await deps.revisor.setRepositoryWorkflow(record, parsed.data.workflow)
      .then(() => true, () => false);
    if (!updated) return c.json({ error: "revisor_workflow_update_failed" }, 502);
    return c.json({ ok: true, workflow: parsed.data.workflow });
  });

  return app;
}

async function inspectWorkspaceRepo(
  deps: ProjectCodesRouterDeps,
  repoPath: string,
): Promise<{ repoPath: string; repoOrigin: string | null } | { error: string }> {
  const context = deps.repoContext ?? { inspectImplementationRepo, isWithinWorkspace };
  const workspaceRoots = deps.resolveWorkspaceRoots();
  if (!await context.isWithinWorkspace(repoPath, workspaceRoots)) {
    return { error: "repository_outside_workspace" };
  }
  const inspected = await context.inspectImplementationRepo(repoPath).catch(() => null);
  if (!inspected) return { error: "invalid_git_repository" };
  if (!await context.isWithinWorkspace(inspected.repoPath, workspaceRoots)) {
    return { error: "repository_outside_workspace" };
  }
  return { repoPath: inspected.repoPath, repoOrigin: inspected.repoOrigin };
}

/** Revisor の登録一覧。 未注入は list: null (unknown)、 到達失敗も null。 */
async function listRevisorRepositories(
  deps: ProjectCodesRouterDeps,
): Promise<{ list: RevisorRepositoryRecord[] | null }> {
  if (!deps.revisor) return { list: null };
  try {
    return { list: await deps.revisor.listRepositories() };
  } catch {
    return { list: null };
  }
}

/** repo_origin (owner/name) → rootPath の順で Revisor 登録を引く。 */
function findRevisorRecord(
  list: RevisorRepositoryRecord[],
  row: ProjectCodeRow,
): RevisorRepositoryRecord | null {
  const ownerRepo = ownerRepoFromOrigin(row.repo_origin);
  if (ownerRepo) {
    const byName = list.find((record) => record.repository.toLowerCase() === ownerRepo.toLowerCase());
    if (byName) return byName;
  }
  const normalizedPath = normalizePath(row.repo_path);
  return list.find((record) => normalizePath(record.rootPath) === normalizedPath) ?? null;
}

/** `https://github.com/OWNER/NAME(.git)` / `git@github.com:OWNER/NAME.git` → `OWNER/NAME` */
export function ownerRepoFromOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
    .exec(origin.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function groupAssignments<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  valueOf: (row: T) => string,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const values = grouped.get(key) ?? [];
    values.push(valueOf(row));
    grouped.set(key, values);
  }
  return grouped;
}

/** Resolution clients do not need audit identities, timestamps, or private remote origins. */
function toResponseRow(row: ProjectCodeRow): ProjectCodeResponseRow {
  return { code: row.code, project: row.project, repo_path: row.repo_path };
}

/** 管理面 (loopback) 向け: repo_origin まで返す。 */
function toAdminRow(row: ProjectCodeRow): Pick<ProjectCodeRow, "code" | "project" | "repo_path" | "repo_origin"> {
  return { code: row.code, project: row.project, repo_path: row.repo_path, repo_origin: row.repo_origin };
}
