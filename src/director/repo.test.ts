import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import type { GeniusCard } from "../inquiry/genius-client.js";
import { DirectorRepo } from "./repo.js";

describe("DirectorRepo", () => {
  it("advances the case timestamp when a decision is recorded", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new DirectorRepo(db);
    repo.createCase({
      id: "case-1",
      title: "判断監査",
      goal: "更新時刻を保つ",
      project: "Cc",
      session_id: null,
      team_id: null,
      created_at: 100,
      updated_at: 100,
    }, [{
      id: "step-1",
      case_id: "case-1",
      sequence: 1,
      kind: "review",
      title: "レビュー",
      status: "active",
      task_path: null,
      delegation_run_id: null,
      local_pr_id: null,
      confirm_run_id: null,
      handoff_note: null,
      created_at: 100,
      updated_at: 100,
    }]);

    repo.createDecision({
      id: "decision-1",
      case_id: "case-1",
      step_id: "step-1",
      kind: "design",
      question: "進めるか",
      facts: [],
      options: [],
      impact: "次工程",
      decision: "self_judge",
      instruction: "通常判断で進める",
      genius_available: false,
      genius_cards: [],
      created_at: 200,
    });

    expect(repo.findCase("case-1")?.updated_at).toBe(200);
    repo.createDecision({
      id: "decision-2",
      case_id: "case-1",
      step_id: "step-1",
      kind: "design",
      question: "再確認するか",
      facts: [],
      options: [],
      impact: "次工程",
      decision: "self_judge",
      instruction: "通常判断で進める",
      genius_available: false,
      genius_cards: [],
      created_at: 150,
    });
    expect(repo.findCase("case-1")?.updated_at).toBe(200);
    db.close();
  });

  it("returns the latest persisted case for only the requested session", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new DirectorRepo(db);
    repo.createCase({
      id: "older-case",
      title: "古い計画",
      goal: "同じセッションの履歴を残す",
      project: "Cc",
      session_id: "session-1",
      team_id: null,
      created_at: 100,
      updated_at: 100,
    }, []);
    repo.createCase({
      id: "latest-case",
      title: "最新の計画",
      goal: "承認対象を特定する",
      project: "Cc",
      session_id: "session-1",
      team_id: null,
      created_at: 200,
      updated_at: 300,
    }, []);
    repo.createCase({
      id: "other-session-case",
      title: "別セッションの計画",
      goal: "セッション境界を守る",
      project: "Cc",
      session_id: "session-2",
      team_id: null,
      created_at: 250,
      updated_at: 400,
    }, []);

    expect(repo.findLatestCaseForSession("session-1")).toEqual({
      id: "latest-case",
      title: "最新の計画",
      goal: "承認対象を特定する",
      project: "Cc",
      session_id: "session-1",
      team_id: null,
      created_at: 200,
      updated_at: 300,
    });
    expect(repo.findLatestCaseForSession("unknown-session")).toBeNull();
    db.close();
  });

  it.each([
    "not-json",
    JSON.stringify({ id: "card-1" }),
    JSON.stringify([{ id: "card-1", title: "判断", score: "high" }]),
    JSON.stringify([{ id: "card-1", title: "判断", score: 0.9, tags: ["ok", 1] }]),
  ])("does not expose malformed persisted Genius cards: %s", (cardsJson) => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(`
      INSERT INTO director_decisions(
        id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
        instruction, genius_available, genius_cards_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "decision-1",
      "case-1",
      "step-1",
      "design",
      "question",
      "[]",
      "[]",
      "impact",
      "proceed",
      "instruction",
      1,
      cardsJson,
      1,
    );

    expect(new DirectorRepo(db).listDecisions("case-1")[0].genius_cards).toEqual([]);
    db.close();
  });

  it("returns only validated Genius card fields", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(`
      INSERT INTO director_decisions(
        id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
        instruction, genius_available, genius_cards_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "decision-1",
      "case-1",
      "step-1",
      "design",
      "question",
      "[]",
      "[]",
      "impact",
      "proceed",
      "instruction",
      1,
      JSON.stringify([{
        id: "card-1",
        title: "判断",
        score: 0.9,
        judgment: "進める",
        internal_path: "C:/private",
      }]),
      1,
    );

    expect(new DirectorRepo(db).listDecisions("case-1")[0].genius_cards).toEqual([{
      id: "card-1",
      title: "判断",
      score: 0.9,
      judgment: "進める",
    }]);
    db.close();
  });

  it("sanitizes Genius cards before storing and returning a new decision", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new DirectorRepo(db);
    const saved = repo.createDecision({
      id: "decision-1",
      case_id: "case-1",
      step_id: "step-1",
      kind: "design",
      question: "question",
      facts: [],
      options: [],
      impact: "impact",
      decision: "proceed",
      instruction: "instruction",
      genius_available: true,
      genius_cards: [{
        id: "card-1",
        title: "判断",
        score: 0.9,
        judgment: "進める",
        internal_path: "C:/private",
      } as GeniusCard & { internal_path: string }],
      created_at: 1,
    });

    expect(saved.genius_cards).toEqual([{
      id: "card-1",
      title: "判断",
      score: 0.9,
      judgment: "進める",
    }]);
    expect(repo.listDecisions("case-1")[0].genius_cards).toEqual(saved.genius_cards);
    db.close();
  });
});
