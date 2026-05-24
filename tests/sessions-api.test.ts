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
  const logsDir = mkdtempSync(join(tmpdir(), "concordia-test-logs-"));
  const processManager = new ProcessManager({ repo: processes, logsDir });
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, rng: () => 1 });
  return buildApp({
    repo, tasks, chat, skills, rules, dayReports, personas, processes, stats, processManager, dispatcher,
    dailyScheduler: { stop: () => {}, runOnce: async () => {} } as any,
    config: { ...loadConfig({}), anthropicApiKey: "" },
    startedAt: new Date().toISOString(),
    sweeperRunOnce: () => {},
    toolPath: "/abs/tools/concordia-hook.mjs",
    publicUrl: "http://127.0.0.1:17330",
  });
}

describe("sessions API", () => {
  let app: ReturnType<typeof buildTestApp>;
  beforeEach(() => { app = buildTestApp(); });

  it("POST /v1/sessions creates and returns peers/advisory", async () => {
    const body1 = {
      id: "a", provider: "claude-code", repo_path: "/x",
      repo_origin: "origin", host: "h", branch: "main",
    };
    const r1 = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body1),
    });
    expect(r1.status).toBe(200);

    const body2 = { ...body1, id: "b" };
    const r2 = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body2),
    });
    const j2 = await r2.json() as any;
    expect(j2.peers).toHaveLength(1);
    expect(j2.peers[0].id).toBe("a");
    expect(j2.advisory.branch_conflict).toBe(true);
    expect(j2.advisory.recommend_worktree).toBe(true);
    expect(typeof j2.advisory.worktree_command).toBe("string");
  });

  it("event append + recent events", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "x", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    const ev = await app.request("/v1/sessions/x/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", payload: { summary: "test" } }),
    });
    expect(ev.status).toBe(200);
    const detail = await app.request("/v1/sessions/x");
    const j = await detail.json() as any;
    expect(j.events.length).toBeGreaterThanOrEqual(2); // start + prompt
    expect(j.events[0].kind).toBe("prompt");
  });

  it("prompt event auto-updates current_task from summary", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ct", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    await app.request("/v1/sessions/ct/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", payload: { summary: "current task summary text" } }),
    });
    const detail = await app.request("/v1/sessions/ct");
    const j = await detail.json() as any;
    expect(j.session.current_task).toBe("current task summary text");

    // 後続 prompt で上書きされる
    await app.request("/v1/sessions/ct/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", payload: { summary: "second task" } }),
    });
    const d2 = await app.request("/v1/sessions/ct");
    const j2 = await d2.json() as any;
    expect(j2.session.current_task).toBe("second task");

    // edit event は current_task を変えない
    await app.request("/v1/sessions/ct/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "edit", payload: { file: "x.ts" } }),
    });
    const d3 = await app.request("/v1/sessions/ct");
    const j3 = await d3.json() as any;
    expect(j3.session.current_task).toBe("second task");
  });

  it("DELETE /v1/sessions/:id ends session + 独立した per-session report 生成", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "z", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    await app.request("/v1/sessions/z/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "edit", payload: { file: "src/foo.ts" } }),
    });
    const r = await app.request("/v1/sessions/z", { method: "DELETE" });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.session.status).toBe("ended");
    expect(j.report.summary_md).toContain("Session z");
    expect(j.report.bullets).toBeTruthy();
  });

  it("PATCH updates current_task", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "p", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    const r = await app.request("/v1/sessions/p", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_task: "doing X" }),
    });
    expect(r.status).toBe(200);
    const detail = await (await app.request("/v1/sessions/p")).json() as any;
    expect(detail.session.current_task).toBe("doing X");
  });

  it("404 for unknown session", async () => {
    const r = await app.request("/v1/sessions/nope");
    expect(r.status).toBe(404);
  });

  it("POST /v1/sessions/:id/inject emits session.inject event + records inject kind", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "inj", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const { eventBus } = await import("../src/events.js");
    const captured: any[] = [];
    const unsub = eventBus.subscribe((ev) => { if (ev.type === "session.inject") captured.push(ev); });
    try {
      const r = await app.request("/v1/sessions/inj/inject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "do the thing", source: "test" }),
      });
      expect(r.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        type: "session.inject",
        target_session_id: "inj",
        text: "do the thing",
        source: "test",
      });
    } finally {
      unsub();
    }

    const detail = await (await app.request("/v1/sessions/inj")).json() as any;
    const kinds = detail.events.map((e: any) => e.kind);
    expect(kinds).toContain("inject");
  });

  it("POST /v1/sessions/:id/inject returns 404 for unknown session", async () => {
    const r = await app.request("/v1/sessions/nope/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(404);
  });

  it("POST /v1/sessions/:id/inject returns 400 for empty text", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "inj2", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const r = await app.request("/v1/sessions/inj2/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(r.status).toBe(400);
  });
});
