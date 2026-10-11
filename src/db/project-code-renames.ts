/**
 * project code の改名履歴 (spec/feature/project-code-registry.md §改名の追跡)。
 * Actio の同期は `renamed_from` を見て、旧 code を指すタスクを新しい code へ付け替える。
 */
import type Database from "better-sqlite3";

export function recordProjectCodeRename(db: Database.Database, from: string, to: string, at: number): void {
  if (from === to) return;
  db.prepare("INSERT INTO project_code_renames(from_code, to_code, renamed_at) VALUES (?, ?, ?)").run(from, to, at);
}

/**
 * code ごとの旧 code (新しい順)。A→B→C なら C は [B, A]。
 * いま登録されている code は旧 code として返さない — 同じ code が別のプロジェクトで
 * 再登録されていれば、それを指すタスクは付け替え対象ではない。
 */
export function renamedFromByCode(
  renames: ReadonlyArray<{ from_code: string; to_code: string; renamed_at: number }>, registered: ReadonlySet<string>,
): Map<string, string[]> {
  const ordered = [...renames].sort((a, b) => b.renamed_at - a.renamed_at);
  const result = new Map<string, string[]>();
  for (const code of registered) {
    const chain: string[] = [];
    const seen = new Set([code]);
    let current = code;
    for (;;) {
      const step = ordered.find((rename) => rename.to_code === current && !seen.has(rename.from_code));
      if (!step) break;
      seen.add(step.from_code);
      if (!registered.has(step.from_code)) chain.push(step.from_code);
      current = step.from_code;
    }
    if (chain.length > 0) result.set(code, chain);
  }
  return result;
}

export function listProjectCodeRenamedFrom(db: Database.Database, registered: ReadonlySet<string>): Map<string, string[]> {
  const renames = db.prepare("SELECT from_code, to_code, renamed_at FROM project_code_renames ORDER BY id")
    .all() as Array<{ from_code: string; to_code: string; renamed_at: number }>;
  return renamedFromByCode(renames, registered);
}
