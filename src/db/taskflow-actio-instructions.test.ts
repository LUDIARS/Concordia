/**
 * migration 136 (taskflow-actio-instructions-broaden) が稼働中 DB に残った旧 task md 指示を
 * 文言の違いに関係なく置き換えるかの検証。
 *
 * 2026-10-14 の委託 run 6ce15f62 には migration 110 の完全一致から漏れた
 * 「作業 → task md (spec/tasks/) に分解」が作業マニュアルとして届いた。
 *
 * @implements spec/feature/task-workflow-v3.md — Backend migration 136
 */

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DEFAULT_MANUALS } from "../control/inject-manual-seed.js";
import { TASK_MD_CONTENT_RULE, TASK_STATE_DB_RULE } from "../taskflow/task-instructions.js";
import { migrateTaskflowActioInstructions } from "./taskflow-actio-instructions.js";

const ENDING = "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。";
const V1_MANUAL = "作業ブランチを確定 → worktree を生成 → 作業 → task md (spec/tasks/) に分解 → コミット → PR 作成まで行う。" + ENDING;
const V2_MANUAL =
  "作業ブランチを確定 → worktree を生成 → 作業 → タスクを spec/tasks/ に新規保存で分解 → コミット → PR 作成まで行う。" +
  "進行状態 (status / 担当 / PR 番号 / 外部タスク ID) は Concordia の DB が正本なので、既存 task md へ書き戻さない。" + ENDING;
const V1_BRANCH_RULE =
  "実装作業は main / develop の直編集・直コミットで行わない。作業内容を解析して作業ブランチを確定し、" +
  "ワークツリーを生成してから作業する。作業完了はタスクワークフロー (task md) に積み、コミット → PR 作成まで行う。" +
  "PR 作成後は停止し、ユーザの明示指示がないレビュー・テスト・マージへ進まない。" +
  "ルートフォルダ (リポ本体) のブランチ切り替え自体は判定対象にしない (不問)。" +
  "判定するのは main/develop への直コミットと、完了フロー (task md → コミット → PR) の欠落である。";

const manual = (db: Database.Database, kind = "実装") =>
  (db.prepare("SELECT content FROM inject_manuals WHERE kind = ?").get(kind) as { content: string } | undefined)?.content;
const rules = (db: Database.Database, title: string) =>
  db.prepare("SELECT title, description, enabled FROM harness_rules WHERE title = ?").all(title) as
    Array<{ title: string; description: string; enabled: number }>;

function withManual(content: string): Database.Database {
  const db = makeTestDb();
  db.prepare("INSERT INTO inject_manuals(kind, content, updated_at) VALUES ('実装', ?, 0)").run(content);
  return db;
}

function insertRule(db: Database.Database, id: string, title: string, description: string): void {
  db.prepare(`INSERT INTO harness_rules(id, kind, title, description, builtin, created_at, updated_at)
    VALUES (?, 'block', ?, ?, 1, 0, 0)`).run(id, title, description);
}

describe("migrateTaskflowActioInstructions", () => {
  it.each([["task md (spec/tasks/) に分解", V1_MANUAL], ["spec/tasks/ に新規保存で分解", V2_MANUAL]])(
    "出荷した旧マニュアル (%s) を現行の既定文へ揃える",
    (_label, content) => {
      const db = withManual(content);

      migrateTaskflowActioInstructions(db);

      expect(manual(db)).toBe(DEFAULT_MANUALS.実装);
    },
  );

  it("ユーザが前後に書き足した旧マニュアルも旧文言の部分だけ置き換える", () => {
    const db = withManual("現場メモ: 先に lint。" + V1_MANUAL.replace(ENDING, "PR は日本語で書く。"));

    migrateTaskflowActioInstructions(db);

    const after = manual(db) ?? "";
    expect(after).toContain("現場メモ: 先に lint。");
    expect(after).toContain("PR は日本語で書く。");
    expect(after).toContain("Actio にタスクを登録・参照");
    expect(after).not.toContain("spec/tasks");
    expect(after).not.toContain("task md");
  });

  it("旧文言を含まないユーザ編集は書き換えない", () => {
    const db = withManual("現場で書き換えた手順");

    migrateTaskflowActioInstructions(db);

    expect(manual(db)).toBe("現場で書き換えた手順");
  });

  it("作業ブランチルールの task md 言及を Actio 参照へ置き換える", () => {
    const db = makeTestDb();
    insertRule(db, "rule-branch", "作業ブランチ + worktree 必須", V1_BRANCH_RULE);

    migrateTaskflowActioInstructions(db);

    const [after] = rules(db, "作業ブランチ + worktree 必須");
    expect(after?.description).toContain("タスクは Actio に登録・参照し、");
    expect(after?.description).toContain("完了フロー (タスク分解 → コミット → PR)");
    expect(after?.description).not.toContain("task md");
  });

  it("旧タイトルの分解ルールだけが残る DB は Actio 登録ルールへ載せ替える", () => {
    const db = makeTestDb();
    insertRule(db, "rule-old", "実装前の task md 分解を必須化", "spec/tasks/ へ md で分解保存");

    migrateTaskflowActioInstructions(db);

    expect(rules(db, "実装前の task md 分解を必須化")).toHaveLength(0);
    const [upgraded] = rules(db, "実装前の Actio タスク登録を必須化");
    // subsidiary/harness-seed.ts が新規 DB へ書く文言と一致させる。
    expect(upgraded?.description).toBe(`実装タスクは着手前に Actio へ登録してから作業する。${TASK_MD_CONTENT_RULE}${TASK_STATE_DB_RULE}`);
  });

  it("新旧両方のタイトルがあれば旧ルールを無効化し、新ルールは触らない", () => {
    const db = makeTestDb();
    insertRule(db, "rule-old", "実装前の task md 分解を必須化", "spec/tasks/ へ md で分解保存");
    insertRule(db, "rule-new", "実装前の Actio タスク登録を必須化", "現行ルール");

    migrateTaskflowActioInstructions(db);

    expect(rules(db, "実装前の task md 分解を必須化")).toEqual([
      { title: "実装前の task md 分解を必須化", description: "spec/tasks/ へ md で分解保存", enabled: 0 },
    ]);
    expect(rules(db, "実装前の Actio タスク登録を必須化")[0]?.description).toBe("現行ルール");
  });

  it("2 回流しても結果は変わらない", () => {
    const db = withManual(V1_MANUAL);
    migrateTaskflowActioInstructions(db);
    const once = manual(db);

    migrateTaskflowActioInstructions(db);

    expect(manual(db)).toBe(once);
  });
});
