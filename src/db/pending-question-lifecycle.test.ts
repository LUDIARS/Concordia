import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordPendingQuestionsRepo } from "./discord-repo.js";
import { reconcilePendingQuestionLifecycle } from "./pending-question-lifecycle.js";

function insertSession(
  db: Database.Database,
  input: {
    id: string;
    status: "active" | "blocked" | "ended" | "lost";
    lastSeenAt: number;
    endedAt?: number;
  },
): void {
  db.prepare(`
    INSERT INTO sessions(id, provider, repo_path, host, started_at, ended_at, status, last_seen_at)
    VALUES (?, 'codex', '/repo', 'host', 1, ?, ?, ?)
  `).run(input.id, input.endedAt ?? null, input.status, input.lastSeenAt);
}

function insertDelegationRun(db: Database.Database, id: string, childSessionId: string): void {
  db.prepare(`
    INSERT INTO delegation_runs(
      id, call_name, target_provider, child_session_id, args_json, rendered_prompt,
      prompt_file_path, status, created_at
    ) VALUES (?, 'worker', 'codex', ?, '{}', 'prompt', '/prompt', 'running', 1)
  `).run(id, childSessionId);
}

describe("pending question lifecycle", () => {
  it("closes ordinary questions immediately after the owning session ends", () => {
    const db = makeTestDb();
    insertSession(db, { id: "ordinary", status: "ended", lastSeenAt: 90, endedAt: 100 });
    const questions = makeDiscordPendingQuestionsRepo(db);
    const question = questions.insert({ session_id: "ordinary", question: "Q", options: ["A"] });
    db.prepare("UPDATE discord_pending_questions SET answer_text = 'preserve-me' WHERE id = ?")
      .run(question.id);

    reconcilePendingQuestionLifecycle(db, 200);

    expect(questions.findById(question.id)).toMatchObject({
      answered_at: null,
      answer_text: "preserve-me",
      close_after: 100,
      closed_at: 200,
      close_reason: "session_inactive",
    });
    expect(questions.listUnanswered("ordinary")).toEqual([]);
  });

  it("keeps active and blocked sessions open", () => {
    const db = makeTestDb();
    insertSession(db, { id: "active", status: "active", lastSeenAt: 100 });
    insertSession(db, { id: "blocked", status: "blocked", lastSeenAt: 100 });
    const questions = makeDiscordPendingQuestionsRepo(db);
    const active = questions.insert({ session_id: "active", question: "A?", options: ["A"] });
    const blocked = questions.insert({ session_id: "blocked", question: "B?", options: ["B"] });

    reconcilePendingQuestionLifecycle(db, 200);

    expect(questions.findById(active.id)).toMatchObject({ close_after: null, closed_at: null });
    expect(questions.findById(blocked.id)).toMatchObject({ close_after: null, closed_at: null });
  });

  it("persists the Taskflow grace deadline across repeated scans and session deletion", () => {
    const db = makeTestDb();
    insertSession(db, { id: "child", status: "ended", lastSeenAt: 90, endedAt: 100 });
    insertDelegationRun(db, "run-1", "child");
    const questions = makeDiscordPendingQuestionsRepo(db);
    const question = questions.insert({ session_id: "child", question: "Q", options: ["A"] });

    reconcilePendingQuestionLifecycle(db, 200);
    expect(questions.findById(question.id)).toMatchObject({ close_after: 86_500, closed_at: null });

    reconcilePendingQuestionLifecycle(db, 500);
    expect(questions.findById(question.id)).toMatchObject({ close_after: 86_500, closed_at: null });

    db.prepare("DELETE FROM sessions WHERE id = 'child'").run();
    reconcilePendingQuestionLifecycle(db, 86_500);
    expect(questions.findById(question.id)).toMatchObject({
      close_after: 86_500,
      closed_at: 86_500,
      close_reason: "session_inactive",
    });
  });

  it("starts an orphaned Taskflow question's grace period at first reconciliation", () => {
    const db = makeTestDb();
    insertDelegationRun(db, "run-orphan", "orphan");
    const questions = makeDiscordPendingQuestionsRepo(db);
    const question = questions.insert({ session_id: "orphan", question: "Q", options: ["A"] });

    reconcilePendingQuestionLifecycle(db, 1_000);

    expect(questions.findById(question.id)).toMatchObject({ close_after: 87_400, closed_at: null });
  });

  it("closes an ordinary orphan on its first reconciliation", () => {
    const db = makeTestDb();
    const questions = makeDiscordPendingQuestionsRepo(db);
    const question = questions.insert({ session_id: "orphan", question: "Q", options: ["A"] });

    reconcilePendingQuestionLifecycle(db, 1_000);

    expect(questions.findById(question.id)).toMatchObject({
      close_after: 1_000,
      closed_at: 1_000,
      close_reason: "session_inactive",
    });
  });

  it("clears a pending deadline on revival and derives a new deadline after the next end", () => {
    const db = makeTestDb();
    insertSession(db, { id: "revived", status: "ended", lastSeenAt: 90, endedAt: 100 });
    insertDelegationRun(db, "run-revived", "revived");
    const questions = makeDiscordPendingQuestionsRepo(db);
    const question = questions.insert({ session_id: "revived", question: "Q", options: ["A"] });
    reconcilePendingQuestionLifecycle(db, 200);
    expect(questions.findById(question.id)?.close_after).toBe(86_500);

    db.prepare("UPDATE sessions SET status = 'active', last_seen_at = 300 WHERE id = 'revived'").run();
    reconcilePendingQuestionLifecycle(db, 300);
    expect(questions.findById(question.id)).toMatchObject({ close_after: null, closed_at: null });

    db.prepare("UPDATE sessions SET status = 'ended', ended_at = 400, last_seen_at = 400 WHERE id = 'revived'").run();
    reconcilePendingQuestionLifecycle(db, 450);
    expect(questions.findById(question.id)).toMatchObject({ close_after: 86_800, closed_at: null });
  });
});
