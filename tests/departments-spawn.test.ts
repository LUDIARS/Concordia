/**
 * 部署を指定した起動・委託 (spec/feature/departments.md §5) の結合確認。
 * admin spawn → pending claim → session 登録で sessions.department_id に焼けるまでを通す。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../src/control/spawner.js";
import { makeTestApp } from "./helpers/test-app.js";

type Env = ReturnType<typeof makeTestApp>;

function spawnSession(env: Env, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(env.app.request("/v1/admin/spawn-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function createDepartment(env: Env, input: {
  name: string;
  slug: string;
  subsidiary_id?: string | null;
  launch?: Record<string, string>;
  projects?: string[];
}) {
  const result = env.departmentService.create({
    subsidiary_id: input.subsidiary_id ?? null,
    name: input.name,
    slug: input.slug,
    settings: { launch: input.launch ?? {}, projects: input.projects ?? [] },
  });
  if (!result.ok) throw new Error(`department setup failed: ${result.error}`);
  return result.department;
}

describe("department-aware spawn", () => {
  let env: Env;
  let spawnCalls: SpawnRequest[];

  beforeEach(() => {
    spawnCalls = [];
    env = makeTestApp({
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 321, command: ["wt.exe", request.provider] };
      },
    });
    env.adminState.setWorkspaceRoot(env.logsDir);
  }, 30_000);

  it("applies department defaults and records the department on the spawned session", async () => {
    const ops = createDepartment(env, {
      name: "運用部", slug: "ops", launch: { provider: "codex", reasoning_effort: "high" },
    });

    const response = await spawnSession(env, { department: ops.id, cwd: env.logsDir });
    expect(response.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.provider).toBe("codex");
    expect(spawnCalls[0]?.args).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=\"high\""]));

    const start = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "dept-session",
        provider: "codex-cli",
        repo_path: spawnCalls[0]?.cwd,
        host: "h",
        metadata: { concordia_spawn_id: spawnCalls[0]?.spawnId },
      }),
    });
    expect(start.status).toBe(200);
    expect(env.repo.findSession("dept-session")?.department_id).toBe(ops.id);

    const listed = await env.app.request(`/v1/sessions?department_id=${ops.id}`);
    const body = await listed.json() as { sessions: Array<{ id: string; department_id: string | null }> };
    expect(body.sessions).toEqual([expect.objectContaining({ id: "dept-session", department_id: ops.id })]);
  });

  it("keeps an explicit provider over the department default (CC-DEPT-INV-05)", async () => {
    const ops = createDepartment(env, { name: "運用部", slug: "ops", launch: { provider: "codex" } });
    const response = await spawnSession(env, { department: ops.id, provider: "claude", cwd: env.logsDir });
    expect(response.status).toBe(200);
    expect(spawnCalls[0]?.provider).toBe("claude");
  });

  it("rejects unknown, archived and foreign departments before spawning", async () => {
    const child = env.subsidiary.create({ name: "child", platform: "discord" });
    const headOffice = createDepartment(env, { name: "開発部", slug: "dev" });
    const archived = createDepartment(env, { name: "旧部", slug: "old" });
    env.departmentService.setArchived(archived.id, true);

    const unknown = await spawnSession(env, { department: "dept_missing", cwd: env.logsDir });
    expect(unknown.status).toBe(404);
    const foreign = await spawnSession(env, { department: headOffice.id, subsidiary_id: child.id, cwd: env.logsDir });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ error: "department_not_owned_by_requested_organization" });
    const closed = await spawnSession(env, { department: archived.id, cwd: env.logsDir });
    expect(await closed.json()).toEqual({ error: "department_archived" });
    expect(spawnCalls).toEqual([]);
  });

  it("refuses a raw cwd for a department with assigned projects (CC-DEPT-INV-04)", async () => {
    const dev = createDepartment(env, { name: "開発部", slug: "dev", projects: ["Concordia"] });
    const response = await spawnSession(env, { department: dev.id, cwd: env.logsDir });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "department_cwd_not_allowed" });
    expect(spawnCalls).toEqual([]);
  });

  it("infers the department from a team and rejects a conflicting department (CC-DEPT-INV-07)", async () => {
    const dev = createDepartment(env, { name: "開発部", slug: "dev" });
    const ops = createDepartment(env, { name: "運用部", slug: "ops" });
    const team = env.teams.create({ name: "Cc", slug: "cc", department_id: dev.id });

    const conflicting = await spawnSession(env, { team: team.id, department: ops.id, cwd: env.logsDir });
    expect(await conflicting.json()).toEqual({ error: "team_department_mismatch" });

    const inferred = await spawnSession(env, { team: team.id, cwd: env.logsDir });
    expect(inferred.status).toBe(200);
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "team-session",
        provider: "claude-code",
        repo_path: spawnCalls[0]?.cwd,
        host: "h",
        metadata: { concordia_spawn_id: spawnCalls[0]?.spawnId },
      }),
    });
    expect(env.repo.findSession("team-session")).toMatchObject({ team_id: team.id, department_id: dev.id });
  });

  it("leaves spawns without a department unassigned (CC-DEPT-INV-08)", async () => {
    const response = await spawnSession(env, { provider: "claude", cwd: env.logsDir });
    expect(response.status).toBe(200);
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "plain-session",
        provider: "claude-code",
        repo_path: spawnCalls[0]?.cwd,
        host: "h",
        metadata: { concordia_spawn_id: spawnCalls[0]?.spawnId },
      }),
    });
    expect(env.repo.findSession("plain-session")?.department_id ?? null).toBeNull();
  });
});

describe("department-aware delegation invoke", () => {
  let env: Env;

  beforeEach(() => {
    env = makeTestApp();
    env.delegation.createTemplate({
      call_name: "dept-invoke",
      title: "Department invoke",
      target_provider: "claude",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
    });
  }, 30_000);

  function invoke(body: Record<string, unknown>): Promise<Response> {
    return Promise.resolve(env.app.request("/v1/delegation/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_name: "dept-invoke", args: { task: "x" }, ...body }),
    }));
  }

  it("records the department on the run", async () => {
    const created = env.departmentService.create({
      subsidiary_id: null, name: "開発部", slug: "dev", settings: { launch: {}, projects: [] },
    });
    if (!created.ok) throw new Error("setup failed");

    const response = await invoke({ department: created.department.id });
    expect(response.status).toBe(200);
    const body = await response.json() as { run: { id: string } };
    expect(env.delegation.findRun(body.run.id)?.department_id).toBe(created.department.id);
  });

  it("rejects a department owned by another organization", async () => {
    const child = env.subsidiary.create({ name: "child", platform: "discord" });
    const created = env.departmentService.create({
      subsidiary_id: child.id, name: "開発部", slug: "dev", settings: { launch: {}, projects: [] },
    });
    if (!created.ok) throw new Error("setup failed");

    const response = await invoke({ department: created.department.id });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "department_not_owned_by_requested_organization" });
  });
});
