/**
 * 人間宛て未回答事項の集約。
 *
 * 4 種別が別々のテーブルに溜まっていて「いま自分が答えるべきものは何件か」を
 * 見る場所が無かった。ここは既存テーブルを束ねて読むだけで、状態は持たない。
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { makeGithubIssueRunsRepo } from "../db/github-issue-runs-repo.js";
import {
  askCardItems,
  confirmPendingItems,
  directorBlockedItems,
  githubIssueApprovalItems,
  inboxItems,
  inquiryAskHumanItems,
} from "./read-model.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function addCard(db: Database.Database, opts: { id?: number; question: string; ts: number; answeredAt?: number }): number {
  const info = db.prepare(`
    INSERT INTO discord_pending_questions(session_id, question, options_json, answered_at, ts)
    VALUES ('sess-1', ?, '[]', ?, ?)
  `).run(opts.question, opts.answeredAt ?? null, opts.ts);
  return Number(info.lastInsertRowid);
}

function addCase(db: Database.Database, caseId: string): void {
  db.prepare(`
    INSERT INTO director_cases(id, title, goal, project, session_id, team_id, created_at, updated_at)
    VALUES (?, 'case', 'goal', 'repo', NULL, NULL, 1, 1)
  `).run(caseId);
}

describe("未回答の質問カード", () => {
  it("未回答だけを拾う", () => {
    const db = makeDb();
    addCard(db, { question: "答えて", ts: 100 });
    addCard(db, { question: "済み", ts: 90, answeredAt: 95 });

    const items = askCardItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].summary).toBe("答えて");
    expect(items[0].kind).toBe("ask-card");
    expect(items[0].raisedAt).toBe(100_000);
  });

  it("inquiry 由来のカードは ask カードとして数えない", () => {
    // 同じカードが「ask カード」と「inquiry ask_human」で 2 件に見えるのを防ぐ。
    const db = makeDb();
    const cardId = addCard(db, { question: "判断が要る", ts: 100 });
    addCase(db, "case-1");
    db.prepare(`
      INSERT INTO director_decisions(
        id, case_id, step_id, kind, question, facts_json, options_json, impact,
        decision, instruction, genius_available, genius_cards_json, pending_question_id, created_at)
      VALUES ('dec-1', 'case-1', 'step-1', 'authority', '判断が要る', '[]', '[]', 'high',
        'ask_human', '', 0, '[]', ?, 100)
    `).run(cardId);

    expect(askCardItems(db)).toEqual([]);
    expect(inquiryAskHumanItems(db)).toHaveLength(1);
  });

  it("カードに複数の判断が束ねられても 1 件として数える", () => {
    const db = makeDb();
    const cardId = addCard(db, { question: "まとめて判断", ts: 100 });
    addCase(db, "case-1");
    const insert = db.prepare(`
      INSERT INTO director_decisions(
        id, case_id, step_id, kind, question, facts_json, options_json, impact,
        decision, instruction, genius_available, genius_cards_json, pending_question_id, created_at)
      VALUES (?, 'case-1', 'step-1', 'authority', ?, '[]', '[]', 'high',
        'ask_human', '', 0, '[]', ?, 100)
    `);
    insert.run("dec-1", "判断 1", cardId);
    insert.run("dec-2", "判断 2", cardId);

    const items = inquiryAskHumanItems(db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: `inquiry-ask-human:${cardId}`,
      summary: "まとめて判断",
      raisedAt: 100_000,
    });
  });

  it("本文が長ければ要旨へ切り詰める", () => {
    const db = makeDb();
    addCard(db, { question: "あ".repeat(300), ts: 100 });

    expect(askCardItems(db)[0].summary.length).toBeLessThanOrEqual(120);
    expect(askCardItems(db)[0].summary.endsWith("…")).toBe(true);
  });
});

describe("inquiry の ask_human", () => {
  it("人間が答えたら消える", () => {
    // 監査行に回答が記録済みなら、カード行の更新前後にかかわらず再掲しない。
    const db = makeDb();
    const cardId = addCard(db, { question: "判断", ts: 100 });
    addCase(db, "case-1");
    db.prepare(`
      INSERT INTO director_decisions(
        id, case_id, step_id, kind, question, facts_json, options_json, impact,
        decision, instruction, genius_available, genius_cards_json,
        pending_question_id, human_answered_at, created_at)
      VALUES ('dec-1', 'case-1', 'step-1', 'authority', '判断', '[]', '[]', 'high',
        'ask_human', '', 0, '[]', ?, 200, 100)
    `).run(cardId);

    expect(inquiryAskHumanItems(db)).toEqual([]);
  });
});

describe("Director の blocked", () => {
  it("blocked の工程だけを拾う", () => {
    const db = makeDb();
    addCase(db, "case-1");
    const insert = db.prepare(`
      INSERT INTO director_steps(id, case_id, sequence, kind, title, status, created_at, updated_at)
      VALUES (?, 'case-1', ?, ?, ?, ?, ?, ?)
    `);
    insert.run("step-1", 1, "decompose", "分解する", "blocked", 100, 200);
    insert.run("step-2", 2, "delegate", "委託する", "running", 110, 110);

    const items = directorBlockedItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].caseId).toBe("case-1");
    expect(items[0].summary).toContain("分解する");
    expect(items[0].raisedAt).toBe(200);
  });
});

describe("confirm の承認待ち", () => {
  it("pending と confirming を拾い、決着済みは拾わない", () => {
    const db = makeDb();
    const insert = db.prepare(`
      INSERT INTO confirm_runs(id, repo_origin, repo_name, pr_number, pr_title, status, created_at, updated_at)
      VALUES (?, 'LUDIARS/Concordia', 'Concordia', ?, ?, ?, ?, ?)
    `);
    insert.run("c-1", 1, "起動待ち", "pending", 100, 100);
    insert.run("c-2", 2, "昇格待ち", "confirming", 110, 110);
    insert.run("c-3", 3, "済み", "confirmed", 120, 120);

    const items = confirmPendingItems(db);
    expect(items.map((i) => i.prNumber)).toEqual([1, 2]);
    expect(items.map((i) => i.repoOrigin)).toEqual(["LUDIARS/Concordia", "LUDIARS/Concordia"]);
    expect(items[0].summary).toContain("起動承認待ち");
    expect(items[1].summary).toContain("昇格承認待ち");
  });
});

describe("GitHub Issue 修正の承認待ち", () => {
  it("awaiting_approval だけを承認インボックスへ出す", () => {
    const db = makeDb();
    const runs = makeGithubIssueRunsRepo(db);
    const input = {
      repoOrigin: "LUDIARS/Concordia",
      issueNumber: 42,
      issueTitle: "落ちる",
      issueUrl: "https://github.com/LUDIARS/Concordia/issues/42",
      label: "Cc",
      actor: "labeler",
      issueAuthor: "reporter",
      projectCode: "Cc",
      repoPath: "E:/Document/Ars/Concordia",
      branch: "cc-issue-42",
    };
    const pending = runs.create(input, "awaiting_approval", 100)!;
    runs.create({ ...input, issueNumber: 43 }, "running", 200);

    expect(githubIssueApprovalItems(db)).toEqual([expect.objectContaining({
      key: `github-issue-approval:${pending.id}`,
      kind: "github-issue-approval",
      githubIssueRunId: pending.id,
      raisedAt: 100,
    })]);
  });
});

describe("統合一覧", () => {
  it("古い順に並べる (放置されているものを先に見せる)", () => {
    const db = makeDb();
    // 質問カードだけは epoch 秒、他の正本は epoch ms で保存される。
    addCard(db, { question: "新しい", ts: 3 });
    addCase(db, "case-1");
    db.prepare(`
      INSERT INTO director_steps(id, case_id, sequence, kind, title, status, created_at, updated_at)
      VALUES ('step-1', 'case-1', 1, 'decompose', '分解する', 'blocked', 500, 1000)
    `).run();
    db.prepare(`
      INSERT INTO confirm_runs(id, repo_origin, repo_name, pr_number, pr_title, status, created_at, updated_at)
      VALUES ('c-1', 'LUDIARS/Concordia', 'Concordia', 1, 't', 'pending', 2000, 2000)
    `).run();

    expect(inboxItems(db).map((i) => i.raisedAt)).toEqual([1000, 2000, 3000]);
  });

  it("key は種別と正本の主キーから決まる", () => {
    // 既読・スヌーズ (UI 状態) がこのキーで項目を指すので、決定的である必要がある。
    const db = makeDb();
    const id = addCard(db, { question: "q", ts: 100 });

    expect(inboxItems(db)[0].key).toBe(`ask-card:${id}`);
    expect(inboxItems(db)[0].key).toBe(inboxItems(db)[0].key);
  });

  it("何も無ければ空", () => {
    expect(inboxItems(makeDb())).toEqual([]);
  });
});
