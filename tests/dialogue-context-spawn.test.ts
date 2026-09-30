/**
 * ユースケース付き部署の起動で、 初回指示に対話の前提データが入ること
 * (spec/feature/dialogue-context.md §5) と、 既定部署への所属 (departments.md §9.2) の結合確認。
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../src/control/spawner.js";
import { makeTestApp } from "./helpers/test-app.js";

type Env = ReturnType<typeof makeTestApp>;

describe("dialogue context on department spawn", () => {
  let env: Env;
  let spawnCalls: SpawnRequest[];

  beforeEach(() => {
    spawnCalls = [];
    env = makeTestApp({
      sessionSpawn: (request) => {
        spawnCalls.push(request);
        return { ok: true, pid: 1, command: ["wt.exe", request.provider] };
      },
    });
    env.adminState.setWorkspaceRoot(env.logsDir);
  }, 30_000);

  function startupPrompt(call: SpawnRequest | undefined): string {
    const path = call?.env?.CONCORDIA_DELEGATION_PROMPT_FILE;
    if (!path) throw new Error("startup prompt was not written");
    return readFileSync(path, "utf8");
  }

  function qaDepartment() {
    const useCase = env.useCaseService.create({ name: "技術相談", slug: "tech-qa", format: "qa" });
    if (!useCase.ok) throw new Error("setup failed");
    env.useCaseCorrections.create({
      use_case_id: useCase.useCase.id, subsidiary_id: null, department_id: null, session_id: null,
      source: "webui", question: "DDD の利点", correction: "境界づけられた文脈で用語を揃えられる", author: "",
    });
    const department = env.departmentService.create({
      subsidiary_id: null, name: "技術相談課", slug: "qa", use_case_id: useCase.useCase.id,
      settings: { launch: { provider: "claude" } },
    });
    if (!department.ok) throw new Error("setup failed");
    return department.department;
  }

  it("puts the use case, corrections and requester notes into the startup prompt", async () => {
    const department = qaDepartment();
    env.requesterProfiles.upsert(
      { subsidiary_id: null, platform: "discord", platform_user_id: "123456" },
      { skill_level: "初級", activities: "Unity のゲーム開発" },
    );

    const response = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        department: department.id,
        cwd: env.logsDir,
        prompt: "DDD って何が良いの",
        requester_discord_user_id: "123456",
        requester_display_name: "neco",
      }),
    });
    expect(response.status).toBe(200);
    const prompt = startupPrompt(spawnCalls[0]);
    expect(prompt).toContain("## 部署: 技術相談課 / ユースケース: 技術相談 (一問一答 Q&A)");
    expect(prompt).toContain("- 問: DDD の利点 / 訂正: 境界づけられた文脈で用語を揃えられる");
    expect(prompt).toContain("- 技術者レベル: 初級");
    expect(prompt).toContain("DDD って何が良いの");
    expect(prompt.indexOf("## 部署:")).toBeLessThan(prompt.indexOf("DDD って何が良いの"));
    expect(env.requesterProfiles.list(null)).toMatchObject([{ platform_user_id: "123456", display_name: "neco" }]);
  });

  it("puts spawns without a department into the organization's default department", async () => {
    const general = env.departmentService.create({ subsidiary_id: null, name: "総務", slug: "general", is_default: true });
    if (!general.ok) throw new Error("setup failed");

    const response = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude", cwd: env.logsDir }),
    });
    expect(response.status).toBe(200);
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "default-session",
        provider: "claude-code",
        repo_path: spawnCalls[0]?.cwd,
        host: "h",
        metadata: { concordia_spawn_id: spawnCalls[0]?.spawnId },
      }),
    });
    expect(env.repo.findSession("default-session")?.department_id).toBe(general.department.id);
  });

  it("registers a correction from a department session", async () => {
    const department = qaDepartment();
    env.repo.insertSession({
      id: "qa-session", provider: "claude-code", repo_path: env.logsDir, repo_origin: null, branch: null, host: "h",
      started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null, department_id: department.id,
    });
    const response = await env.app.request("/v1/sessions/qa-session/corrections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "集約は小さく保つ", source: "discord", author: "123456" }),
    });
    expect(response.status).toBe(201);
    expect(env.useCaseCorrections.list(department.use_case_id!)).toHaveLength(2);
  });
});
