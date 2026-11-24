import { expect, it } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { SqliteAgentInstructionStore } from "../../db/agent-instructions-repo.js";
import { previousKaizenDay } from "../agent-jobs/kaizen-daily.js";
import { CRON_JOBS } from "../cron-jobs.js";
import { createKaizenFactsReader } from "./kaizen-facts.js";

it("前日の JST 境界で失敗と停滞を集計し、自由記述や非公開の呼び名を出さない", () => {
  const db = makeTestDb();
  try {
    const day = previousKaizenDay(new Date("2026-11-24T00:00:00Z"));
    expect(day).toEqual({ date: "2026-11-23", start: new Date("2026-11-22T15:00:00Z"), end: new Date("2026-11-23T15:00:00Z") });
    const start = day.start.getTime() / 1000;
    const end = day.end.getTime() / 1000;
    const insertRun = db.prepare(`
      INSERT INTO delegation_runs (id, call_name, target_provider, rendered_prompt, prompt_file_path,
        status, error, triggered_by, created_at, finished_at)
      VALUES (?, ?, 'codex', 'private body', '/private', 'failed', 'timeout with private text', ?, ?, ?)`);
    insertRun.run("from", "kaizen-daily", "cron:kaizen-daily", start * 1000 - 5, start * 1000);
    insertRun.run("until", "kaizen-daily", "cron:kaizen-daily", start * 1000, end * 1000);
    insertRun.run("custom", "private-template", null, start * 1000, start * 1000);
    db.prepare("INSERT INTO session_events (session_id, ts, kind, payload) VALUES ('person', ?, ?, ?)")
      .run(start, "push_hook_decision", JSON.stringify({ allowed: false, reason: "private" }));
    db.prepare(`INSERT INTO control_cards (id, source_kind, source_key, card_kind, summary,
      state, raised_at, created_at, updated_at) VALUES ('card', 'test', 'one', 'human_action', 'private', 'open', ?, ?, ?)`)
      .run(start * 1000, start * 1000, start * 1000);
    const instructions = new SqliteAgentInstructionStore(db);
    instructions.insert({ id: "instruction", agent: "dots", type: "run_task", title: "private",
      body: "private", params: "{}", created_at: "2026-11-22T14:05:00Z" });
    instructions.markAcked("instruction", "2026-11-22T14:15:00Z");
    instructions.requeueAckedBefore("2026-11-22T14:31:00Z", "2026-11-22T15:01:00Z");
    const read = createKaizenFactsReader(db, CRON_JOBS);
    db.prepare("UPDATE schema_migrations SET applied_at = ? WHERE name = 'cron-agent-job-evidence'").run(end * 1000);
    expect(read(day).instruction_requeues).toBeNull();
    db.prepare("UPDATE schema_migrations SET applied_at = ? WHERE name = 'cron-agent-job-evidence'").run(start * 1000);
    expect(read(day)).toEqual({
      failed_runs: [{ call_name: "kaizen-daily", reason: "timeout", count: 1 }, { call_name: "other", reason: "timeout", count: 1 }],
      failed_cron_jobs: [{ job: "kaizen-daily", count: 1 }],
      human_waiting: 1,
      instruction_requeues: 1,
      hook_denials: [{ kind: "push_hook_decision", count: 1 }],
    });
  } finally {
    db.close();
  }
});
