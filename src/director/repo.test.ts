import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import type { GeniusCard } from "../inquiry/genius-client.js";
import { DirectorRepo } from "./repo.js";

describe("DirectorRepo", () => {
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
