/**
 * 大文字小文字だけが違う project code の検出 (spec/feature/project-code-registry.md §大文字小文字の衝突)。
 * code は区別して扱うので登録は止めない。名前を小文字で引く経路と衝突しうることを警告で返す。
 */
export interface ProjectCodeCaseWarning {
  kind: "case_collision";
  code: string;
  conflicts_with: string[];
}

export function caseCollisionWarnings(code: string, registered: Iterable<string>): ProjectCodeCaseWarning[] {
  const folded = code.toLowerCase();
  const conflicts = [...registered].filter((other) => other !== code && other.toLowerCase() === folded);
  return conflicts.length > 0 ? [{ kind: "case_collision", code, conflicts_with: conflicts.sort() }] : [];
}
