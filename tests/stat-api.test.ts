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

function makeApp() {
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
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, rng: () => 0.99 });
  const app = buildApp({
    repo, tasks, chat, skills, rules, dayReports, personas, processes, stats, processManager, dispatcher,
    dailyScheduler: { stop: () => {}, runOnce: async () => {} } as any,
    config: loadConfig({}),
    startedAt: new Date().toISOString(),
    sweeperRunOnce: () => {},
    toolPath: "/abs/tools/concordia-hook.mjs",
    publicUrl: "http://127.0.0.1:17330",
  });
  return { app, repo, stats };
}

function startSession(repo: SessionsRepo, id: string, opts: { branch?: string; repo_path?: string } = {}) {
  repo.insertSession({
    id, provider: "claude-code",
    repo_path: opts.repo_path ?? "/abs/Concordia",
    repo_origin: "github:LUDIARS/Concordia",
    branch: opts.branch ?? "main",
    host: "h",
    started_at: 1, last_seen_at: Math.floor(Date.now() / 1000),
    transcript_path: null, metadata: null,
  });
}

describe("/v1/stat", () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => { env = makeApp(); });

  it("POST /v1/stat/:id stores stat and GET returns it", async () => {
    startSession(env.repo, "sess-a");
    const post = await env.app.request("/v1/stat/sess-a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          active_repos: [{ repo: "Concordia", branch: "main", uncommitted: 0, unpushed: 0 }],
          recent_work: "schema v9 追加",
        },
      }),
    });
    expect(post.status).toBe(200);

    const get = await env.app.request("/v1/stat/sess-a");
    expect(get.status).toBe(200);
    const body = await get.json() as any;
    expect(body.latest.payload.recent_work).toBe("schema v9 追加");
    expect(body.history).toHaveLength(1);
    expect(body.session.id).toBe("sess-a");
  });

  it("POST /v1/stat/:id rejects unknown session", async () => {
    const r = await env.app.request("/v1/stat/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { recent_work: "x" } }),
    });
    expect(r.status).toBe(404);
  });

  it("GET /v1/stat lists latest per session (cross-session visibility)", async () => {
    startSession(env.repo, "sess-a");
    startSession(env.repo, "sess-b");
    env.stats.insert({ session_id: "sess-a", ts: 100, payload: { recent_work: "A1" } });
    env.stats.insert({ session_id: "sess-a", ts: 200, payload: { recent_work: "A2" } });
    env.stats.insert({ session_id: "sess-b", ts: 150, payload: { recent_work: "B1" } });

    const r = await env.app.request("/v1/stat");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.items).toHaveLength(2);
    const a = body.items.find((i: any) => i.session_id === "sess-a");
    expect(a.payload.recent_work).toBe("A2");
    expect(a.session?.id).toBe("sess-a");
  });
});

describe("/v1/monitor/conflicts (新規ブランチ前の競合チェック)", () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => { env = makeApp(); });

  it("returns active sessions touching same repo", async () => {
    startSession(env.repo, "a", { branch: "feat/x", repo_path: "/abs/Concordia" });
    startSession(env.repo, "b", { branch: "main",   repo_path: "/abs/Concordia" });
    startSession(env.repo, "c", { branch: "main",   repo_path: "/abs/Other" });

    const r = await env.app.request("/v1/monitor/conflicts?repo=/abs/Concordia");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.conflicts).toHaveLength(2);
    expect(body.branches.map((b: any) => b.branch).sort()).toEqual(["feat/x", "main"]);
  });

  it("matches by repo_origin too", async () => {
    startSession(env.repo, "a", { branch: "feat/x", repo_path: "/abs/Concordia" });
    const r = await env.app.request("/v1/monitor/conflicts?repo=github:LUDIARS/Concordia");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.conflicts).toHaveLength(1);
  });

  it("filters by branch when given", async () => {
    startSession(env.repo, "a", { branch: "feat/x", repo_path: "/abs/Concordia" });
    startSession(env.repo, "b", { branch: "main",   repo_path: "/abs/Concordia" });
    const r = await env.app.request("/v1/monitor/conflicts?repo=/abs/Concordia&branch=feat/x");
    const body = await r.json() as any;
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].id).toBe("a");
  });

  it("excludes session via exclude_session param", async () => {
    startSession(env.repo, "self", { branch: "feat/x", repo_path: "/abs/Concordia" });
    startSession(env.repo, "other", { branch: "main", repo_path: "/abs/Concordia" });
    const r = await env.app.request("/v1/monitor/conflicts?repo=/abs/Concordia&exclude_session=self");
    const body = await r.json() as any;
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].id).toBe("other");
  });

  it("returns 400 when repo param missing", async () => {
    const r = await env.app.request("/v1/monitor/conflicts");
    expect(r.status).toBe(400);
  });
});
