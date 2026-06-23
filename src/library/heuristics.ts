/**
 * メモリ/スキル中身の poison heuristics (純粋)。
 *
 * `src/skills/analyzer.ts` の DANGER_PATTERNS と同系統。 こちらは library 向けに
 * 危険コマンド + prompt-injection に絞った検出。 ヒットした理由文字列を返す
 * (重み付けはせず「人間レビューを促すフラグ」として扱う)。
 */

const DANGER_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /rm\s+-rf\s+\/(?!\w)/, reason: "rm -rf / パターン" },
  { re: /rm\s+-rf\s+~/, reason: "rm -rf ~ パターン" },
  { re: /:\(\)\{[^}]*\};:/, reason: "fork bomb パターン" },
  { re: /curl[^|\n]*\|\s*(?:sh|bash|zsh)/, reason: "curl | sh パイプ" },
  { re: /wget[^|\n]*\|\s*(?:sh|bash|zsh)/, reason: "wget | sh パイプ" },
  { re: /ghp_[A-Za-z0-9]{20,}/, reason: "GitHub token らしき文字列" },
  { re: /AKIA[0-9A-Z]{16}/, reason: "AWS access key id らしき文字列" },
  { re: /sk-[A-Za-z0-9]{20,}/, reason: "API key らしき文字列" },
  { re: /ignore\s+(?:previous|prior|all)\s+(?:instructions|rules)/i, reason: "prompt injection: ignore previous instructions" },
  { re: /disregard\s+(?:safety|guardrails)/i, reason: "prompt injection: disregard safety" },
  { re: /you\s+are\s+now\s+(?:a|an)\s+/i, reason: "role-rewrite パターン" },
];

/** 中身を走査し、 当たった危険理由の配列を返す (無ければ空)。 */
export function scanPoison(content: string): string[] {
  const reasons: string[] = [];
  for (const p of DANGER_PATTERNS) {
    if (p.re.test(content)) reasons.push(p.reason);
  }
  return reasons;
}
