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
  return buildApp({
    repo, tasks, chat, skills, rules, dayReports, personas, processes, stats, processManager, dispatcher,
    dailyScheduler: { stop: () => {}, runOnce: async () => {} } as any,
    config: loadConfig({}),
    startedAt: new Date().toISOString(),
    sweeperRunOnce: () => {},
    toolPath: "/abs/path/tools/concordia-hook.mjs",
    publicUrl: "http://127.0.0.1:17330",
  });
}

describe("/v1/setup", () => {
  it("returns skill content and hook config", async () => {
    const app = makeApp();
    const r = await app.request("/v1/setup");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;

    expect(j.service).toBe("concordia");
    expect(j.url).toBe("http://127.0.0.1:17330");
    expect(j.provider).toBe("claude-code");
    expect(j.skill_version).toMatch(/\d+\.\d+\.\d+/);

    expect(j.install.skills).toHaveLength(1);
    expect(j.install.skills[0].target_path).toBe("~/.claude/skills/concordia/SKILL.md");
    expect(j.install.skills[0].content).toContain("name: concordia");
    expect(j.install.skills[0].content).toContain("Concordia 連携スキル");

    const hooks = j.install.settings_merge.hooks;
    expect(hooks.SessionStart[0].hooks[0].command).toContain("session-start");
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain("prompt");
    expect(hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit");
    expect(hooks.Stop[0].hooks[0].command).toContain("session-end");
  });

  it("respects ?provider= query", async () => {
    const app = makeApp();
    const r = await app.request("/v1/setup?provider=gemini-cli");
    const j = (await r.json()) as any;
    expect(j.provider).toBe("gemini-cli");
  });
});
