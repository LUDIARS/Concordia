import type Database from "better-sqlite3";

// Immutable migration 110 literals. Runtime instructions may evolve independently.
const CONTENT = "タスクワークフロー v3.0: タスク本文は Actio に記録する。POST /v1/taskflow/tasks に session_id・固定 request_id(UUID)・title・body・kind・memory_links を送る。応答の actio:<id> を参照し、必要時だけ GET /v1/taskflow/tasks/content?session_id=<自分>&reference=actio:<id> で読む。タスク本文をファイル・Cc のメモリ・PR・ログへ自動複製しない。Actio が利用できなければ停止して報告する。";
const STATE = "タスク本文とタスク状態の正本は Actio。Cc は Actio ID と session/run/PR の実行関連を管理する。状態更新は PATCH /v1/taskflow/tasks/state に repo_path・task_path=actio:<id>・status を送る。";
/** Matches `subsidiary/harness-seed.ts`; a new DB and a migrated DB must agree. */
const RULE_PREFIX = "実装タスクは着手前に Actio へ登録してから作業する。";

/**
 * inject_manuals の 実装 既定行が移行後に持つ文言。
 * `control/inject-manual-seed.ts` が新規 DB へ書く文字列と 1 文字も違ってはいけない
 * (稼働中 DB と新規 DB で既定文言が割れる)。 `db/inject-manuals-repo.test.ts` が突合する。
 */
const MANUAL_PREFIX = "作業ブランチを確定 → worktree を生成 → Actio にタスクを登録・参照 → 作業 → コミット → PR 作成まで行う。";
const MANUAL_STATE = "タスク本文・状態は Actio が正本。Cc は参照と実行関連だけを保持し、タスクファイルを作成しない。";

/** Upgrade shipped task-file guidance; preserve user-authored unrelated rules. */
export function migrateTaskflowV3Instructions(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(confirm_runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "actio_task_ref")) {
    db.exec("ALTER TABLE confirm_runs ADD COLUMN actio_task_ref TEXT");
  }
  db.prepare(`UPDATE harness_rules SET title = '実装前の Actio タスク登録を必須化', description = ?,
    updated_at = strftime('%s','now') * 1000 WHERE builtin = 1 AND title = '実装前の task md 分解を必須化'`)
    .run(RULE_PREFIX + CONTENT + STATE);
  db.prepare(`UPDATE harness_rules SET description = replace(description, ?, ?),
    updated_at = strftime('%s','now') * 1000 WHERE builtin = 1 AND title = '作業ブランチ + worktree 必須'`)
    .run("作業完了はタスクワークフロー (spec/tasks/ への新規保存) に積み、", "タスクは Actio に登録・参照し、");
  const oldPrefix = "作業ブランチを確定 → worktree を生成 → 作業 → タスクを spec/tasks/ に新規保存で分解 → コミット → PR 作成まで行う。";
  const oldState = "進行状態 (status / 担当 / PR 番号 / 外部タスク ID) は Concordia の DB が正本なので、既存 task md へ書き戻さない。";
  const ending = "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。";
  db.prepare(`UPDATE inject_manuals SET content = ?, updated_at = strftime('%s','now') * 1000 WHERE kind = '実装' AND content = ?`)
    .run(MANUAL_PREFIX + MANUAL_STATE + ending, oldPrefix + oldState + ending);
}
