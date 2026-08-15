import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "../../tests/helpers/db.js";
import { INJECT_MANUAL_KINDS, InjectManualsRepo, isInjectManualKind } from "./inject-manuals-repo.js";
import { seedInjectManuals } from "../control/inject-manual-seed.js";
import { TASK_STATE_DB_RULE_SHORT } from "../taskflow/task-instructions.js";

describe("InjectManualsRepo", () => {
  let db: Database.Database;
  let repo: InjectManualsRepo;

  beforeEach(() => {
    db = makeTestDb();
    repo = new InjectManualsRepo(db);
  });

  it("upsert は新規行を作り、get で取り出せる", () => {
    const row = repo.upsert("実装", "実装の手順", 1000);
    expect(row).toEqual({ kind: "実装", content: "実装の手順", updated_at: 1000 });
    expect(repo.get("実装")).toEqual(row);
  });

  it("upsert は既存行の content / updated_at を上書きする", () => {
    repo.upsert("レビュー", "v1", 1000);
    const row = repo.upsert("レビュー", "v2", 2000);
    expect(row.content).toBe("v2");
    expect(row.updated_at).toBe(2000);
    // 行が増えていない (kind PK)
    expect(repo.list()).toHaveLength(1);
  });

  it("get は未登録 kind に null を返す", () => {
    expect(repo.get("実装")).toBeNull();
  });

  it("list は kind の固定語彙順で返す", () => {
    repo.upsert("雑用", "z", 1);
    repo.upsert("設計相談", "d", 1);
    repo.upsert("レビュー", "r", 1);
    expect(repo.list().map((m) => m.kind)).toEqual(["設計相談", "レビュー", "雑用"]);
  });

  it("seed は全 kind を投入する (冪等)", () => {
    seedInjectManuals(repo);
    seedInjectManuals(repo);
    const rows = repo.list();
    expect(rows.map((m) => m.kind)).toEqual([...INJECT_MANUAL_KINDS]);
    for (const row of rows) expect(row.content.length).toBeGreaterThan(0);
  });

  it("seed は既存行の content を上書きしない (ユーザ編集尊重)", () => {
    seedInjectManuals(repo);
    repo.upsert("レビュー", "ユーザが編集した内容", 9999);
    seedInjectManuals(repo);
    const row = repo.get("レビュー");
    expect(row?.content).toBe("ユーザが編集した内容");
    expect(row?.updated_at).toBe(9999);
  });

  it("isInjectManualKind は固定語彙のみ true", () => {
    for (const kind of INJECT_MANUAL_KINDS) expect(isInjectManualKind(kind)).toBe(true);
    expect(isInjectManualKind("実装2")).toBe(false);
    expect(isInjectManualKind("")).toBe(false);
  });
});

describe("実装マニュアルの進行状態ルール", () => {
  /**
   * migration 59 (taskflow-inject-state-in-db) が既定行へ書き込むリテラル。
   * 適用済み migration は書き換えられないので、 seed の既定値がここからずれると
   * 「新規 DB と稼働中 DB で既定文言が違う」 状態になる。 それを検出する。
   */
  const MIGRATED_DEFAULT =
    "作業ブランチを確定 → worktree を生成 → 作業 → タスクを spec/tasks/ に新規保存で分解 → コミット → PR 作成まで行う。" +
    "進行状態 (status / 担当 / PR 番号 / 外部タスク ID) は Concordia の DB が正本なので、既存 task md へ書き戻さない。" +
    "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。";

  it("seed の既定文言が migration 59 の書き込む文言と一致する", () => {
    const repo = new InjectManualsRepo(makeTestDb());
    seedInjectManuals(repo);
    expect(repo.get("実装")?.content).toBe(MIGRATED_DEFAULT);
  });

  it("共有定数から組み立てられている (経路ごとに文言がずれない)", () => {
    const repo = new InjectManualsRepo(makeTestDb());
    seedInjectManuals(repo);
    expect(repo.get("実装")?.content).toContain(TASK_STATE_DB_RULE_SHORT);
  });
});
