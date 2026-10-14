import type Database from "better-sqlite3";

/**
 * migration 136 (taskflow-actio-instructions-broaden).
 *
 * migration 110 は「タスクを spec/tasks/ に新規保存で分解」の完全一致しか置き換えなかった。
 * 59 より後に seed された DB には旧文言「task md (spec/tasks/) に分解」が残り、委託の作業
 * マニュアルとして届き続けた (2026-10-14 run 6ce15f62)。ここでは出荷した旧文言の
 * 言い回しを部分一致で置き換え、ユーザが書いた他の文は残す。
 *
 * 文字列はこの migration の不変リテラル。実行時の文言は taskflow/task-instructions.ts と
 * control/inject-manual-seed.ts / subsidiary/harness-seed.ts が持ち、ここと一致させる。
 *
 * @implements spec/feature/task-workflow-v3.md — Backend migration 136
 */

const MANUAL_ENDING = "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。";
const MANUAL_PREFIX = "作業ブランチを確定 → worktree を生成 → Actio にタスクを登録・参照 → 作業 → コミット → PR 作成まで行う。";
const MANUAL_STATE = "タスク本文・状態は Actio が正本。Cc は参照と実行関連だけを保持し、タスクファイルを作成しない。";

/** 出荷した実装マニュアル全文 (状態文なし版)。状態文を補って新しい既定文へ揃える。 */
const SHIPPED_MANUAL_V1 =
  "作業ブランチを確定 → worktree を生成 → 作業 → task md (spec/tasks/) に分解 → コミット → PR 作成まで行う。" + MANUAL_ENDING;

/** [旧, 新] の部分置換。出荷した旧文言の言い回しを網羅する。 */
const MANUAL_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["→ 作業 → task md (spec/tasks/) に分解 →", "→ Actio にタスクを登録・参照 → 作業 →"],
  ["→ 作業 → タスクを spec/tasks/ に新規保存で分解 →", "→ Actio にタスクを登録・参照 → 作業 →"],
  ["進行状態 (status / 担当 / PR 番号 / 外部タスク ID) は Concordia の DB が正本なので、既存 task md へ書き戻さない。", MANUAL_STATE],
];

const BRANCH_RULE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["作業完了はタスクワークフロー (spec/tasks/ への新規保存) に積み、", "タスクは Actio に登録・参照し、"],
  ["作業完了はタスクワークフロー (task md) に積み、", "タスクは Actio に登録・参照し、"],
  ["完了フロー (task md → コミット → PR)", "完了フロー (タスク分解 → コミット → PR)"],
];

const OLD_RULE_TITLE = "実装前の task md 分解を必須化";
const NEW_RULE_TITLE = "実装前の Actio タスク登録を必須化";
const NEW_RULE_DESCRIPTION =
  "実装タスクは着手前に Actio へ登録してから作業する。" +
  "タスクワークフロー v3.0: タスク本文は Actio に記録する。POST /v1/taskflow/tasks に session_id・固定 request_id(UUID)・title・body・kind・memory_links を送る。応答の actio:<id> を参照し、必要時だけ GET /v1/taskflow/tasks/content?session_id=<自分>&reference=actio:<id> で読む。タスク本文をファイル・Cc のメモリ・PR・ログへ自動複製しない。Actio が利用できなければ停止して報告する。" +
  "タスク本文とタスク状態の正本は Actio。Cc は Actio ID と session/run/PR の実行関連を管理する。状態更新は PATCH /v1/taskflow/tasks/state に repo_path・task_path=actio:<id>・status を送る。";

function replaceAll(text: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  return replacements.reduce((next, [from, to]) => next.split(from).join(to), text);
}

function migrateManuals(db: Database.Database, now: number): void {
  const rows = db.prepare("SELECT kind, content FROM inject_manuals").all() as Array<{ kind: string; content: string }>;
  const update = db.prepare("UPDATE inject_manuals SET content = ?, updated_at = ? WHERE kind = ?");
  for (const row of rows) {
    const next = row.content === SHIPPED_MANUAL_V1
      ? MANUAL_PREFIX + MANUAL_STATE + MANUAL_ENDING
      : replaceAll(row.content, MANUAL_REPLACEMENTS);
    if (next !== row.content) update.run(next, now, row.kind);
  }
}

function migrateBranchRule(db: Database.Database, now: number): void {
  const rows = db.prepare("SELECT id, description FROM harness_rules WHERE builtin = 1 AND title = '作業ブランチ + worktree 必須'")
    .all() as Array<{ id: string; description: string }>;
  const update = db.prepare("UPDATE harness_rules SET description = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const next = replaceAll(row.description, BRANCH_RULE_REPLACEMENTS);
    if (next !== row.description) update.run(next, now, row.id);
  }
}

/**
 * 110 の後に旧 seed が旧タイトルの builtin を入れた DB を直す。新タイトルが無ければ載せ替え、
 * 既にあれば旧行は無効化する (削除はしない。ユーザ編集の痕跡を残す)。
 */
function migrateDecomposeRule(db: Database.Database, now: number): void {
  const hasNew = db.prepare("SELECT 1 FROM harness_rules WHERE builtin = 1 AND title = ?").get(NEW_RULE_TITLE) !== undefined;
  if (hasNew) {
    db.prepare("UPDATE harness_rules SET enabled = 0, updated_at = ? WHERE builtin = 1 AND title = ?").run(now, OLD_RULE_TITLE);
    return;
  }
  db.prepare("UPDATE harness_rules SET title = ?, description = ?, updated_at = ? WHERE builtin = 1 AND title = ?")
    .run(NEW_RULE_TITLE, NEW_RULE_DESCRIPTION, now, OLD_RULE_TITLE);
}

/** Replace every shipped task-file phrasing left in runtime instructions; keep unrelated custom text. */
export function migrateTaskflowActioInstructions(db: Database.Database, now = Date.now()): void {
  migrateManuals(db, now);
  migrateBranchRule(db, now);
  migrateDecomposeRule(db, now);
}
