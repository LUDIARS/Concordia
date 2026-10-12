/**
 * M5 の直近判定に使う md ファイルの git 最終コミット時刻を読む (sync-migration-legacy-recency.ts)。
 * 状態行の updated_at が分かる行は読まない。shell を通さず、path は `--` の後ろに置いて引数として渡す。
 */
import { execFileSync } from "node:child_process";
import { isLegacyTaskRow } from "../../taskflow/sync-migration-legacy.js";
import { legacyRowKey } from "../../taskflow/sync-migration-legacy-recency.js";
import type { MigrationStateRow } from "../../taskflow/sync-migration-types.js";

/** epoch 秒の文字列を返す (コミットが無ければ空)。失敗は呼び出し側で不明として扱う。 */
export type GitLastCommit = (repoPath: string, taskPath: string) => string;

export const gitLastCommit: GitLastCommit = (repoPath, taskPath) => execFileSync("git",
  ["-C", repoPath, "log", "-1", "--format=%ct", "--", taskPath], {
    encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });

export function legacyCommitTimes(rows: readonly MigrationStateRow[], read: GitLastCommit = gitLastCommit): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (!isLegacyTaskRow(row) || (row.updated_at ?? 0) > 0) continue;
    const path = row.task_path.replace(/\\/g, "/");
    let output = "";
    try { output = read(row.repo_path, path).trim(); } catch { continue; }
    if (/^\d+$/.test(output)) result.set(legacyRowKey(row.repo_path, path), Number(output) * 1000);
  }
  return result;
}
