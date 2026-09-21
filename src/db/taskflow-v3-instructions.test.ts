/**
 * migration 110 (taskflow-v3-actio-instructions) が「稼働中の DB」に何をするかの検証。
 *
 * migration-ledger.test.ts は checksum とスキーマ指紋を凍結するが、 既定文言を
 * 実際に v2 → v3 へ差し替えたか、 ユーザが編集した行を残したかまでは見ない。
 * ここが落ちる変更は、 アップグレードした環境だけ古い文言のまま動く。
 *
 * @implements spec/feature/task-workflow-v3.md — Backend migration 110
 */

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TASK_MD_CONTENT_RULE, TASK_STATE_DB_RULE } from "./taskflow-v2-instructions.js";
import { migrateTaskflowV3Instructions } from "./taskflow-v3-instructions.js";

const V2_RULE = `実装タスクは着手前に分解保存してから作業する。${TASK_MD_CONTENT_RULE}${TASK_STATE_DB_RULE}`;
const V2_MANUAL =
  "作業ブランチを確定 → worktree を生成 → 作業 → タスクを spec/tasks/ に新規保存で分解 → コミット → PR 作成まで行う。" +
  "進行状態 (status / 担当 / PR 番号 / 外部タスク ID) は Concordia の DB が正本なので、既存 task md へ書き戻さない。" +
  "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。";

const rule = (db: Database.Database, title: string) =>
  db.prepare("SELECT title, description FROM harness_rules WHERE title = ?").get(title) as
    { title: string; description: string } | undefined;
const manual = (db: Database.Database, kind: string) =>
  (db.prepare("SELECT content FROM inject_manuals WHERE kind = ?").get(kind) as { content: string } | undefined)?.content;

const V2_BRANCH_RULE =
  "実装作業は main / develop の直編集・直コミットで行わない。作業内容を解析して作業ブランチを確定し、" +
  "ワークツリーを生成してから作業する。作業完了はタスクワークフロー (spec/tasks/ への新規保存) に積み、コミット → PR 作成まで行う。" +
  "PR 作成後は停止し、ユーザの明示指示がないレビュー・テスト・マージへ進まない。" +
  "ルートフォルダ (リポ本体) のブランチ切り替え自体は判定対象にしない (不問)。" +
  "判定するのは main/develop への直コミットと、完了フロー (タスク分解 → コミット → PR) の欠落である。";

/** migration 59 まで適用され、 builtin が seed 済みの「稼働中 DB」を再現する。 */
function v2Database(): Database.Database {
  const db = makeTestDb();
  const insertRule = db.prepare(`INSERT INTO harness_rules(id, kind, title, description, builtin, created_at, updated_at)
    VALUES (?, 'block', ?, ?, 1, 0, 0)`);
  insertRule.run("rule-decompose", "実装前の task md 分解を必須化", V2_RULE);
  insertRule.run("rule-branch", "作業ブランチ + worktree 必須", V2_BRANCH_RULE);
  db.prepare("INSERT INTO inject_manuals(kind, content, updated_at) VALUES ('実装', ?, 0)").run(V2_MANUAL);
  return db;
}

describe("migrateTaskflowV3Instructions", () => {
  it("既定の task md ルールを Actio 登録ルールへ載せ替える", () => {
    const db = v2Database();
    expect(rule(db, "実装前の task md 分解を必須化")).toBeDefined();

    migrateTaskflowV3Instructions(db);

    const upgraded = rule(db, "実装前の Actio タスク登録を必須化");
    expect(upgraded?.description).toContain("実装タスクは着手前に Actio へ登録してから作業する。");
    expect(upgraded?.description).toContain("POST /v1/taskflow/tasks");
    expect(upgraded?.description).not.toContain("spec/tasks/<YYYY-MM-DD>-<slug>.md");
    expect(rule(db, "実装前の task md 分解を必須化")).toBeUndefined();
  });

  it("実装マニュアルの既定行を Actio 参照の手順へ差し替える", () => {
    const db = v2Database();

    migrateTaskflowV3Instructions(db);

    expect(manual(db, "実装")).toBe(
      "作業ブランチを確定 → worktree を生成 → Actio にタスクを登録・参照 → 作業 → コミット → PR 作成まで行う。" +
      "タスク本文・状態は Actio が正本。Cc は参照と実行関連だけを保持し、タスクファイルを作成しない。" +
      "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。",
    );
  });

  it("作業ブランチルールの spec/tasks/ 言及だけを置き換え、他の文はそのまま残す", () => {
    const db = v2Database();
    const before = rule(db, "作業ブランチ + worktree 必須")?.description ?? "";

    migrateTaskflowV3Instructions(db);

    const after = rule(db, "作業ブランチ + worktree 必須")?.description ?? "";
    expect(before).toContain("作業完了はタスクワークフロー (spec/tasks/ への新規保存) に積み、");
    expect(after).toContain("タスクは Actio に登録・参照し、");
    expect(after).toContain("ルートフォルダ (リポ本体) のブランチ切り替え自体は判定対象にしない (不問)。");
  });

  /** WebUI で編集された運用文言を移行で握り潰さない (migration 59 と同じ約束)。 */
  it("ユーザが編集した行は書き換えない", () => {
    const db = v2Database();
    db.prepare("UPDATE inject_manuals SET content = ? WHERE kind = '実装'").run("現場で書き換えた手順");

    migrateTaskflowV3Instructions(db);

    expect(manual(db, "実装")).toBe("現場で書き換えた手順");
  });

  it("confirm_runs へ Actio 参照列を一度だけ足す", () => {
    const db = makeTestDb();
    const columns = () => (db.prepare("PRAGMA table_info(confirm_runs)").all() as Array<{ name: string }>)
      .filter((column) => column.name === "actio_task_ref");

    expect(columns()).toHaveLength(1);
    expect(() => migrateTaskflowV3Instructions(db)).not.toThrow();
    expect(columns()).toHaveLength(1);
  });
});
