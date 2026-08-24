import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { applyMigrations, MIGRATIONS, SCHEMA_VERSION } from "../src/db/schema.js";
import { migrationChecksum, runMigrations } from "../src/db/migrator.js";
import { makeRawTestDb } from "./helpers/db.js";

describe("schema", () => {
  it("creates tables and indexes", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("session_events");
    expect(names).toContain("session_reports");
    expect(names).toContain("slack_session_channels");
    expect(names).toContain("slack_session_threads");
    expect(names).toContain("schema_meta");
    expect(names).toContain("federation_sites");
    expect(names).toContain("federation_outbox");
    expect(names).not.toContain("liveness_history");
    expect(names).not.toContain("service_instance_logs");

    const v = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
  });

  it("does not create persona tables on fresh DB (persona 機構撤去済み)", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).not.toContain("personas");
    expect(names).not.toContain("persona_assignments");
    expect(names).not.toContain("persona_feedback_log");
  });

  it("forum migration columns exist on a fresh DB", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const templateColumns = db.prepare(`PRAGMA table_info(delegation_templates)`).all() as Array<{ name: string }>;
    const sessionColumns = db.prepare(`PRAGMA table_info(discord_session_channels)`).all() as Array<{ name: string }>;
    const testSurfaceColumns = db.prepare(`PRAGMA table_info(discord_test_surfaces)`).all() as Array<{ name: string }>;
    expect(templateColumns.some((column) => column.name === "forum_tag")).toBe(true);
    expect(sessionColumns.some((column) => column.name === "surface_message_id")).toBe(true);
    expect(testSurfaceColumns.some((column) => column.name === "repo_root_path")).toBe(true);
    expect(testSurfaceColumns.some((column) => column.name === "head_branch")).toBe(true);
  });

  it("leaves orphan persona tables in legacy DB untouched (孤児テーブル放置)", () => {
    const db = makeRawTestDb();
    // legacy DB: 旧 persona 機構のテーブルが残っている状態
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE personas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      traits TEXT NOT NULL DEFAULT '[]', speech_style TEXT NOT NULL DEFAULT '',
      skill_template TEXT NOT NULL DEFAULT '', learned_notes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO personas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run("legacy", "旧人格", 1, 1);

    // 撤去後の migration がエラー無く通り、孤児テーブルは drop されない
    applyMigrations(db);
    const row = db.prepare(`SELECT name FROM personas WHERE id = 'legacy'`).get() as { name: string };
    expect(row.name).toBe("旧人格");

    // 2回目もエラー無く通る
    applyMigrations(db);
  });

  it("leaves obsolete Excubitor tables to the external maintenance command", () => {
    const db = makeRawTestDb();
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES('version', '34');
      CREATE TABLE hosts (id TEXT PRIMARY KEY);
      CREATE TABLE services (id TEXT PRIMARY KEY);
      CREATE TABLE service_instances (id TEXT PRIMARY KEY);
      CREATE TABLE liveness_history (id INTEGER PRIMARY KEY);
      CREATE TABLE service_instance_logs (id INTEGER PRIMARY KEY);
      CREATE TABLE error_rules (id TEXT PRIMARY KEY);
      CREATE TABLE error_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE auto_fix_runs (id TEXT PRIMARY KEY);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY);
    `);

    applyMigrations(db);
    const obsolete = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'hosts', 'services', 'service_instances', 'liveness_history',
           'service_instance_logs', 'error_rules', 'error_tasks', 'auto_fix_runs', 'audit_log'
         )`,
      )
      .all();
    expect(obsolete).toHaveLength(9);
    expect(
      db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });

    expect(() => applyMigrations(db)).not.toThrow();
  });

  it("upgrades an applied Director v56 schema without editing its migration", () => {
    const db = makeRawTestDb();
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE director_cases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        project TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE director_steps (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        task_path TEXT,
        delegation_run_id TEXT,
        local_pr_id TEXT,
        confirm_run_id TEXT,
        handoff_note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(case_id, sequence)
      );
      CREATE INDEX idx_director_steps_case_sequence
        ON director_steps(case_id, sequence);
      CREATE TABLE director_decisions (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        question TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        options_json TEXT NOT NULL,
        impact TEXT NOT NULL,
        decision TEXT NOT NULL,
        instruction TEXT NOT NULL,
        genius_available INTEGER NOT NULL,
        genius_cards_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_director_decisions_case_created
        ON director_decisions(case_id, created_at ASC);
      CREATE INDEX idx_director_decisions_step_created
        ON director_decisions(step_id, created_at ASC);
      INSERT INTO director_decisions VALUES
        ('z-first', 'case-1', 'step-1', 'design', 'first', '[]', '[]', 'impact',
         'self_judge', 'instruction', 0, '[]', 100),
        ('a-second', 'case-1', 'step-1', 'design', 'second', '[]', '[]', 'impact',
         'self_judge', 'instruction', 0, '[]', 100);
    `);
    const v56 = {
      version: 56,
      name: "director-script-flow",
      source: "director_cases + director_steps + director_decisions v1",
    };
    db.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)
    `).run(v56.version, v56.name, migrationChecksum(v56), 1);

    applyMigrations(db);

    const decisions = db.prepare(`
      SELECT id, audit_sequence FROM director_decisions ORDER BY audit_sequence ASC
    `).all() as Array<{ id: string; audit_sequence: number }>;
    expect(decisions).toEqual([
      { id: "z-first", audit_sequence: 1 },
      { id: "a-second", audit_sequence: 2 },
    ]);
    const indexes = db.prepare(`PRAGMA index_list(director_steps)`).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).not.toContain("idx_director_steps_case_sequence");
  });
});

describe("migration 60: taskflow runtime-state constraints", () => {
  it("upgrades an applied v54 table without changing its migration checksum", () => {
    const db = makeRawTestDb();
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE taskflow_task_state (
        repo_path TEXT NOT NULL,
        task_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        source_session TEXT,
        assignee TEXT,
        owner TEXT,
        delegation_run_id TEXT,
        pr_number INTEGER,
        memoria_task_id TEXT,
        actio_task_id TEXT,
        memoria_registration_state TEXT NOT NULL DEFAULT 'idle',
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo_path, task_path)
      );
      INSERT INTO taskflow_task_state VALUES
        ('E:/repo', 'spec/tasks/valid.md', 'delegated', NULL, NULL, NULL, NULL, 367, 'memoria-1', NULL, 'created', 1),
        ('E:/repo', 'spec/tasks/legacy.md', 'invalid', NULL, NULL, NULL, NULL, 0, NULL, NULL, 'created', 2);
    `);
    const v54 = {
      version: 54,
      name: "taskflow-runtime-state",
      source: "taskflow_task_state v1",
    };
    db.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)
    `).run(v54.version, v54.name, migrationChecksum(v54), 1);

    applyMigrations(db);

    expect(db.prepare(`
      SELECT status, pr_number, memoria_task_id, memoria_registration_state
        FROM taskflow_task_state WHERE task_path = 'spec/tasks/valid.md'
    `).get()).toEqual({
      status: "delegated", pr_number: 367, memoria_task_id: "memoria-1", memoria_registration_state: "created",
    });
    expect(db.prepare(`
      SELECT status, pr_number, memoria_task_id, memoria_registration_state
        FROM taskflow_task_state WHERE task_path = 'spec/tasks/legacy.md'
    `).get()).toEqual({
      status: "pending", pr_number: null, memoria_task_id: null, memoria_registration_state: "idle",
    });
    expect(() => db.prepare(`
      INSERT INTO taskflow_task_state(repo_path, task_path, status, memoria_registration_state)
      VALUES ('E:/repo', 'spec/tasks/bad.md', 'paused', 'idle')
    `).run()).toThrow();
  });
});

describe("migration 73: Delegation SDK safety and legacy deletion", () => {
  it("deletes legacy definitions, preserves run history, and converts live Codex paths", () => {
    const db = makeRawTestDb();
    runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 72), 72);
    db.exec(`
      INSERT INTO delegation_templates(
        id, call_name, title, target_provider, prompt_template, created_at, updated_at
      ) VALUES
        ('legacy-template', 'claude-sonnet-5-impl', 'Legacy', 'claude', 'old', 1, 1),
        ('live-template', 'custom-codex', 'Custom', 'codex', 'new', 1, 1);
      INSERT INTO delegation_runs(
        id, template_id, call_name, target_provider, args_json,
        rendered_prompt, prompt_file_path, status, created_at
      ) VALUES
        ('historical-run', 'legacy-template', 'claude-sonnet-5-impl', 'claude', '{}', 'old', '/old.md', 'completed', 1),
        ('queued-run', 'live-template', 'custom-codex', 'codex', '{}', 'new', '/new.md', 'queued', 2),
        ('completed-codex-run', 'live-template', 'custom-codex', 'codex', '{}', 'done', '/done.md', 'completed', 3);
      INSERT INTO subsidiary_delegations(
        subsidiary_id, call_name, target_provider, created_at, updated_at
      ) VALUES
        ('sub-1', 'codex-5-6-terra', 'codex', 1, 1),
        ('sub-1', 'custom-codex', 'codex', 1, 1);
    `);

    applyMigrations(db);

    expect(db.prepare(`SELECT id FROM delegation_templates WHERE id = 'legacy-template'`).get())
      .toBeUndefined();
    expect(db.prepare(`SELECT call_name FROM subsidiary_delegations WHERE call_name = 'codex-5-6-terra'`).get())
      .toBeUndefined();
    expect(db.prepare(`SELECT template_id, call_name FROM delegation_runs WHERE id = 'historical-run'`).get())
      .toEqual({ template_id: null, call_name: "claude-sonnet-5-impl" });
    expect(db.prepare(`SELECT target_provider FROM delegation_templates WHERE id = 'live-template'`).get())
      .toEqual({ target_provider: "codex-sdk" });
    expect(db.prepare(`SELECT target_provider FROM subsidiary_delegations WHERE call_name = 'custom-codex'`).get())
      .toEqual({ target_provider: "codex-sdk" });
    expect(db.prepare(`SELECT target_provider FROM delegation_runs WHERE id = 'queued-run'`).get())
      .toEqual({ target_provider: "codex-sdk" });
    expect(db.prepare(`SELECT target_provider FROM delegation_runs WHERE id = 'completed-codex-run'`).get())
      .toEqual({ target_provider: "codex" });
  });
});

// migration 44 は「旧リアクションWF allowlist → 社員名簿の管理職」の一度きりの移行。
// ここが落ちるとアップグレード直後に spawn / 発火できる人間が 0 人になるので、
// 取り込み・`*` 破棄・env フォールバックの 3 点を固定する
// (spec/feature/staff-roster.md §4)。
describe("migration 44: reaction allowlist → staff roster", () => {
  const ENV_KEYS = [
    "CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS",
    "CONCORDIA_REACTION_WORKFLOW_SLACK_USERS",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    // 実行環境の .env が漏れてくると期待値が揺れるので、毎回明示的に外す。
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function seedLegacyAllowlist(db: ReturnType<typeof makeRawTestDb>, key: string, value: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`).run(key, value);
  }

  function roster(db: ReturnType<typeof makeRawTestDb>) {
    return db
      .prepare(`SELECT platform, platform_user_id, role FROM staff_members ORDER BY platform, platform_user_id`)
      .all() as Array<{ platform: string; platform_user_id: string; role: string }>;
  }

  it("imports persisted allowlist IDs as 管理職 and drops the * sentinel", () => {
    const db = makeRawTestDb();
    seedLegacyAllowlist(db, "admin.reaction_workflow_discord_users", JSON.stringify(["d1", "d2"]));
    seedLegacyAllowlist(db, "admin.reaction_workflow_slack_users", JSON.stringify(["*", "s1"]));

    applyMigrations(db);

    expect(roster(db)).toEqual([
      { platform: "discord", platform_user_id: "d1", role: "manager" },
      { platform: "discord", platform_user_id: "d2", role: "manager" },
      { platform: "slack", platform_user_id: "s1", role: "manager" },
    ]);
    // 再適用しても重複行を作らない (migration 台帳で 1 度きり)。
    applyMigrations(db);
    expect(roster(db)).toHaveLength(3);
  });

  it("falls back to the retired env allowlist when nothing was persisted", () => {
    process.env.CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS = "d1, d2;d3";
    const db = makeRawTestDb();

    applyMigrations(db);

    expect(roster(db)).toEqual([
      { platform: "discord", platform_user_id: "d1", role: "manager" },
      { platform: "discord", platform_user_id: "d2", role: "manager" },
      { platform: "discord", platform_user_id: "d3", role: "manager" },
    ]);
  });

  it("treats a persisted empty allowlist as authoritative over the env fallback", () => {
    process.env.CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS = "d1";
    const db = makeRawTestDb();
    seedLegacyAllowlist(db, "admin.reaction_workflow_discord_users", "[]");

    applyMigrations(db);

    expect(roster(db)).toEqual([]);
  });

  it("creates an empty roster on a fresh DB with no legacy configuration", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    expect(roster(db)).toEqual([]);
  });
});
