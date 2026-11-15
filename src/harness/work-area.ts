/** @implements spec/feature/task-branch-harness.md TB-WORKAREA */
import { relative, resolve, isAbsolute, sep } from "node:path";

/**
 * TB-WORKAREA: Claude Code がリポジトリの外に持つ、セッション専用の作業領域。
 * - session scratchpad: `<tmpdir>/claude/<project hash>/<session id>/scratchpad/...`
 * - project memory: `<Claude config dir>/projects/<project slug>/memory/...`
 * どちらも git 管理外なので `git rev-parse` が失敗し、編集ツールが全部止まっていた (2026-11-12)。
 * ここに当たる編集だけを task-branch の照合対象から外す。他の git 管理外パスは従来どおり拒否する (fail-closed)。
 * 渡すパスは symlink / junction を解決した実パス (supervisor の physicalPath) であること。
 */
export interface WorkAreaBases {
  tmpDirs: readonly string[];
  claudeConfigDirs: readonly string[];
}

function segmentsUnder(base: string, path: string): string[] | null {
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const rel = relative(fold(resolve(base)), fold(resolve(path)));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(/[\\/]+/).filter(Boolean);
}

/** パスが session scratchpad か project memory の中 (そのディレクトリ自体を含む) にあるか。 */
export function isClaudeWorkArea(path: string, bases: WorkAreaBases): boolean {
  const scratch = bases.tmpDirs.some(base => {
    const parts = segmentsUnder(base, path);
    return parts !== null && parts.length >= 4 && parts[0] === "claude" && parts[3] === "scratchpad";
  });
  if (scratch) return true;
  return bases.claudeConfigDirs.some(base => {
    const parts = segmentsUnder(base, path);
    return parts !== null && parts.length >= 3 && parts[0] === "projects" && parts[2] === "memory";
  });
}
