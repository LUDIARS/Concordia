import { describe, it, expect } from "vitest";
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
import { tokensMatch, extractBearer } from "../src/shared/admin-auth.js";

function makeApp(adminToken: string) {
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
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, rng: () => 0.99 });
  return buildApp({
    repo, tasks, chat, skills, rules, dayReports, personas, processes, stats, sessionTaskRecords, adminState, processManager, dispatcher,
    dailyScheduler: { stop: () => {}, runOnce: async () => {} } as any,
    config: { ...loadConfig({}), adminToken },
    startedAt: new Date().toISOString(),
    sweeperRunOnce: () => {},
    toolPath: "/abs/path/tools/concordia-hook.mjs",
    publicUrl: "http://127.0.0.1:17330",
  });
}

describe("admin-auth helpers", () => {
  it("tokensMatch は一致のみ true、 空は不一致", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("abc", "")).toBe(false);
  });

  it("extractBearer は Bearer scheme を大小無視で剥がす", () => {
    expect(extractBearer("Bearer xyz")).toBe("xyz");
    expect(extractBearer("bearer  xyz ")).toBe("xyz");
    expect(extractBearer("Basic xyz")).toBe("");
    expect(extractBearer(undefined)).toBe("");
  });
});

describe("admin auth middleware on /v1/admin/* and /v1/sweeper/run", () => {
  it("token 未設定なら無認証で通る (loopback 信頼境界)", async () => {
    const app = makeApp("");
    const r = await app.request("/v1/sweeper/run", { method: "POST" });
    expect(r.status).toBe(200);
    const r2 = await app.request("/v1/admin/truncate-sessions", { method: "POST" });
    expect(r2.status).toBe(200);
  });

  it("token 設定済み + ヘッダ無しは 401", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", { method: "POST" });
    expect(r.status).toBe(401);
    const r2 = await app.request("/v1/admin/truncate-sessions", { method: "POST" });
    expect(r2.status).toBe(401);
  });

  it("token 設定済み + 正しい Bearer は通る", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", {
      method: "POST",
      headers: { authorization: "Bearer s3cr3t" },
    });
    expect(r.status).toBe(200);
  });

  it("token 設定済み + X-Concordia-Admin-Token でも通る", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", {
      method: "POST",
      headers: { "x-concordia-admin-token": "s3cr3t" },
    });
    expect(r.status).toBe(200);
  });

  it("token 設定済み + 誤った token は 401", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(r.status).toBe(401);
  });

  it("admin 以外のルートは token 設定済みでも素通し", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/health");
    expect(r.status).toBe(200);
  });
});
