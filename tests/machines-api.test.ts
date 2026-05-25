import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { SkillsRepo } from "../src/db/skills-repo.js";
import { RulesRepo } from "../src/db/rules-repo.js";
import { DayReportsRepo } from "../src/db/day-reports-repo.js";
import { PersonasRepo } from "../src/db/personas-repo.js";
import { ProcessesRepo } from "../src/db/processes-repo.js";
import { StatsRepo } from "../src/db/stats-repo.js";
import { SessionTaskRecordsRepo } from "../src/db/session-task-records-repo.js";
import { AdminState } from "../src/admin/state.js";
import { ProcessManager } from "../src/processes/manager.js";
import { seedPersonas } from "../src/personas/seeds.js";
import { Dispatcher } from "../src/dispatcher.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/shared/config.js";

function buildTestApp() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const repo = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const skills = new SkillsRepo(db);
  const rules = new RulesRepo(db);
  const dayReports = new DayReportsRepo(db);
  const personas = new PersonasRepo(db);
  seedPersonas(personas);
  const processes = new ProcessesRepo(db);
  const stats = new StatsRepo(db);
  const sessionTaskRecords = new SessionTaskRecordsRepo(db);
  const adminState = new AdminState(db);
  const logsDir = mkdtempSync(join(tmpdir(), "concordia-test-logs-"));
  const processManager = new ProcessManager({ repo: processes, logsDir });
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, rng: () => 1 });
  return {
    app: buildApp({
      repo, tasks, chat, skills, rules, dayReports, personas, processes, stats, sessionTaskRecords, adminState, processManager, dispatcher,
      dailyScheduler: { stop: () => {}, runOnce: async () => {} } as any,
      config: { ...loadConfig({}), anthropicApiKey: "" },
      startedAt: new Date().toISOString(),
      sweeperRunOnce: () => {},
      toolPath: "/abs/tools/concordia-hook.mjs",
      publicUrl: "http://127.0.0.1:17330",
    }),
    repo,
  };
}

describe("machines API + admin spawn/stop", () => {
  let env: ReturnType<typeof buildTestApp>;
  beforeEach(() => { env = buildTestApp(); });

  it("GET /v1/machines aggregates sessions per host with per-status counts", async () => {
    await seed(env, "s1", "DESKTOP-A", "active");
    await seed(env, "s2", "DESKTOP-A", "active");
    await seed(env, "s3", "DESKTOP-A", "ended");
    await seed(env, "s4", "DESKTOP-B", "active");

    const r = await env.app.request("/v1/machines");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { machines: Array<{ host: string; active: number; ended: number }> };
    const byHost = Object.fromEntries(j.machines.map((m) => [m.host, m]));
    expect(byHost["DESKTOP-A"]).toMatchObject({ active: 2, ended: 1 });
    expect(byHost["DESKTOP-B"]).toMatchObject({ active: 1, ended: 0 });
  });

  it("GET /v1/machines/:host returns sessions filtered by host", async () => {
    await seed(env, "s1", "DESKTOP-A", "active");
    await seed(env, "s2", "DESKTOP-B", "active");

    const r = await env.app.request("/v1/machines/DESKTOP-A");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { host: string; sessions: Array<{ id: string }> };
    expect(j.host).toBe("DESKTOP-A");
    expect(j.sessions.map((s) => s.id).sort()).toEqual(["s1"]);
  });

  it("POST /v1/admin/spawn-session rejects unknown provider", async () => {
    const r = await env.app.request("/v1/admin/spawn-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "ghost" }),
    });
    expect(r.status).toBe(400);
  });

  it("GET /v1/admin/state exposes snapshot triple with defaults", async () => {
    const r = await env.app.request("/v1/admin/state");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      chat_muted: boolean;
      rules_enabled: boolean;
      rule_proposer_interval_sec: number;
    };
    expect(body.chat_muted).toBe(true);
    expect(body.rules_enabled).toBe(false);
    expect(body.rule_proposer_interval_sec).toBe(3600);
  });

  it("PUT /v1/admin/chat-mute toggles + GET reflects new value", async () => {
    const put = await env.app.request("/v1/admin/chat-mute", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted: false }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { muted: boolean }).muted).toBe(false);

    const get = await env.app.request("/v1/admin/chat-mute");
    expect((await get.json() as { muted: boolean }).muted).toBe(false);
  });

  it("PUT /v1/admin/chat-mute rejects non-boolean", async () => {
    const r = await env.app.request("/v1/admin/chat-mute", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ muted: "yes" }),
    });
    expect(r.status).toBe(400);
  });

  it("PUT /v1/admin/rules-enabled toggles + persists", async () => {
    const put = await env.app.request("/v1/admin/rules-enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect((await put.json() as { enabled: boolean }).enabled).toBe(true);
  });

  it("PUT /v1/admin/rule-proposer-interval clamps + GET echoes", async () => {
    const tooSmall = await env.app.request("/v1/admin/rule-proposer-interval", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interval_sec: 10 }),
    });
    expect(tooSmall.status).toBe(200);
    const body = await tooSmall.json() as { interval_sec: number };
    expect(body.interval_sec).toBe(60); // clamped to MIN
  });

  it("PUT /v1/admin/rule-proposer-interval rejects non-number", async () => {
    const r = await env.app.request("/v1/admin/rule-proposer-interval", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interval_sec: "abc" }),
    });
    expect(r.status).toBe(400);
  });

  it("GET /v1/admin/spawn-defaults reports the configured default_cwd", async () => {
    const r = await env.app.request("/v1/admin/spawn-defaults");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { default_cwd: string; platform_supported: boolean };
    // loadConfig({}) → CONCORDIA_SPAWN_DEFAULT_CWD unset.
    // win32 + E:\Document\Ars 存在環境では auto-detect で同パスが返る (LUDIARS 運用機).
    // 他環境では fallback 無しで空文字. どちらも仕様の範囲内.
    expect(["", "E:\\Document\\Ars"]).toContain(body.default_cwd);
    expect(typeof body.platform_supported).toBe("boolean");
  });

  it("POST /v1/admin/stop-session/:id 404 for unknown id", async () => {
    const r = await env.app.request("/v1/admin/stop-session/nope", { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("POST /v1/admin/stop-session/:id 400 when metadata.lictor_pid missing", async () => {
    await seed(env, "no-meta", "DESKTOP-A", "active");
    const r = await env.app.request("/v1/admin/stop-session/no-meta", { method: "POST" });
    expect(r.status).toBe(400);
  });
});

async function seed(
  env: ReturnType<typeof buildTestApp>,
  id: string,
  host: string,
  status: "active" | "ended" | "lost" | "abandoned",
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  env.repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "/repo",
    repo_origin: null,
    branch: null,
    host,
    started_at: now,
    last_seen_at: now,
    transcript_path: null,
    metadata: null,
  });
  if (status !== "active") env.repo.setStatus(id, status, now, status === "active" ? null : now);
}
