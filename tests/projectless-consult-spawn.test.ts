/**
 * 子会社のプロジェクトを持たない相談部署からの起動 (spec/feature/tech-consultation.md §6) の結合確認。
 * admin spawn が相談用ディレクトリを cwd にし、 claude のツール制限を付け、 作業領域の指定を拒否する。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../src/control/spawner.js";
import { PROJECTLESS_CONSULT_CLAUDE_ARGS } from "../src/consultation/projectless-consult.js";
import { makeTestDir } from "./helpers/db.js";
import { makeTestApp } from "./helpers/test-app.js";

type Env = ReturnType<typeof makeTestApp>;

function spawnSession(env: Env, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(env.app.request("/v1/admin/spawn-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("projectless consultation spawn in a subsidiary", () => {
  let env: Env;
  let spawnCalls: SpawnRequest[];
  let workspaceRoot: string;
  let subsidiaryId: string;
  let consultDepartmentId: string;
  let editDepartmentId: string;
  let headOfficeConsultId: string;

  beforeEach(() => {
    spawnCalls = [];
    workspaceRoot = makeTestDir("concordia-consult-ws-");
    env = makeTestApp({
      consultWorkspaceRoot: workspaceRoot,
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 99, command: ["wt.exe", request.provider] };
      },
    });
    env.adminState.setWorkspaceRoot(env.logsDir);
    subsidiaryId = env.subsidiary.create({ name: "glab", platform: "discord" }).id;
    const qa = env.useCases.create({
      name: "技術相談", slug: "tech-qa", format: "qa", summary: "", work_mode: "read-only", pre_data: "",
      use_requester_profile: false, intake_enabled: false,
    });
    const chores = env.useCases.create({
      name: "雑用", slug: "chores", format: "chores", summary: "", work_mode: "edit", pre_data: "",
      use_requester_profile: false, intake_enabled: false,
    });
    const consult = env.departmentService.create({
      subsidiary_id: subsidiaryId, name: "技術相談課", slug: "tech-consulting", settings: {}, use_case_id: qa.id,
    });
    const edit = env.departmentService.create({
      subsidiary_id: subsidiaryId, name: "総務", slug: "general", settings: {}, use_case_id: chores.id,
    });
    const headOffice = env.departmentService.create({
      subsidiary_id: null, name: "技術相談課", slug: "tech-consulting", settings: {}, use_case_id: qa.id,
    });
    if (!consult.ok || !edit.ok || !headOffice.ok) throw new Error("department setup failed");
    consultDepartmentId = consult.department.id;
    editDepartmentId = edit.department.id;
    headOfficeConsultId = headOffice.department.id;
  }, 30_000);

  it("spawns claude in the subsidiary consult workspace with the tool restriction", async () => {
    const response = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", prompt: "DDD の利点は?",
    });
    expect(response.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    const expectedCwd = join(workspaceRoot, subsidiaryId.replace(/[^A-Za-z0-9_-]/g, "_"));
    expect(spawnCalls[0]?.cwd).toBe(expectedCwd);
    expect(existsSync(expectedCwd)).toBe(true);
    expect(spawnCalls[0]?.args?.slice(-PROJECTLESS_CONSULT_CLAUDE_ARGS.length)).toEqual([...PROJECTLESS_CONSULT_CLAUDE_ARGS]);
  });

  it("rejects a project, cwd, extra args or a non-claude provider (CC-CONSULT-INV-07)", async () => {
    const withCwd = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", cwd: env.logsDir,
    });
    expect(withCwd.status).toBe(400);
    expect(await withCwd.json()).toEqual({ error: "projectless_consult_scope_fixed: cwd" });

    const withArgs = await spawnSession(env, {
      department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", args: ["--tools=default"],
    });
    expect(await withArgs.json()).toEqual({ error: "projectless_consult_scope_fixed: args" });

    const codex = await spawnSession(env, { department: consultDepartmentId, subsidiary_id: subsidiaryId, provider: "codex" });
    expect(await codex.json()).toEqual({ error: "projectless_consult_requires_claude" });
    expect(spawnCalls).toEqual([]);
  });

  it("spawns a head-office consultation in the head-office consult workspace without tool restriction", async () => {
    // 2026-10-02: 本社の相談部署はプロジェクトが無く、 cwd を決められずに起動に失敗していた。
    const response = await spawnSession(env, { department: headOfficeConsultId, provider: "claude", prompt: "DDD の利点は?" });
    expect(response.status).toBe(200);
    expect(spawnCalls[0]?.cwd).toBe(join(workspaceRoot, "head-office"));
    // 上位の CLAUDE.md と自動メモリを読まない (2026-10-02 の流出対策、 CC-CONSULT-INV-08)。
    const settings = JSON.parse(readFileSync(join(workspaceRoot, "head-office", ".claude", "settings.local.json"), "utf8")) as Record<string, unknown>;
    expect(settings).toMatchObject({ autoMemoryEnabled: false, claudeMdExcludes: expect.arrayContaining(["**/CLAUDE.md"]) });
    expect(spawnCalls[0]?.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(spawnCalls[0]?.args ?? []).not.toEqual(expect.arrayContaining(["--strict-mcp-config"]));
  });

  it("leaves a head-office consultation with an explicit cwd on that cwd", async () => {
    const response = await spawnSession(env, { department: headOfficeConsultId, provider: "claude", cwd: env.logsDir });
    expect(response.status).toBe(200);
    expect(spawnCalls[0]?.cwd).toBe(env.logsDir);
  });

  it("leaves other departments untouched", async () => {
    const response = await spawnSession(env, {
      department: editDepartmentId, subsidiary_id: subsidiaryId, provider: "claude", cwd: env.logsDir,
    });
    expect(response.status).toBe(200);
    expect(spawnCalls[0]?.cwd).toBe(env.logsDir);
    expect(spawnCalls[0]?.args ?? []).not.toEqual(expect.arrayContaining(["--strict-mcp-config"]));
  });
});
