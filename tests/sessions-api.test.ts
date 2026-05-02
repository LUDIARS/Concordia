import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { Dispatcher } from "../src/dispatcher.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/shared/config.js";

function buildTestApp() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const repo = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, rng: () => 1 }); // 確率発火しない
  const cfg = loadConfig({});
  return buildApp({
    repo, tasks, chat, dispatcher, config: cfg,
    startedAt: new Date().toISOString(),
    sweeperRunOnce: () => {},
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

  it("DELETE /v1/sessions/:id ends + generates report", async () => {
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
});
