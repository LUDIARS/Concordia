import type { Predicate } from "./predicates.js";

/** Castra harness-guard rules now have a provider-neutral Cc owner. No magic-comment bypass. */
export const bashKnownHazards: Predicate = action => {
  if (action.tool !== "Bash" || !action.command) return null;
  const command = action.command;
  const checks = [
    [/\bgit\b[\s\S]*\breset\b[\s\S]*--hard\b/i, "bash-reset-hard", "共有 checkout の変更を破棄する reset --hard は実行できません。"],
    [/\b(?:cp|copy|mv)\b[\s\S]*\.(?:db|sqlite|sqlite3)\b/i, "bash-sqlite-copy", "稼働 SQLite のファイル複製・置換を避け、DB 所有者の backup/更新 API を使用してください。"],
    [/\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\b[\s\S]*backup/i, "bash-backup-removal", "復旧用 backup の再帰削除は対象と復旧状況を確認してください。"],
  ] as const;
  for (const [pattern, rule, reason] of checks) if (pattern.test(command)) {
    return { rule, decision: "deny", reason, suggestion: "元の指示と対象を確認し、既存の安全な専用ツールを使用してください。" };
  }
  if (action.isWorktree && /\bgh\s+pr\s+merge\b/i.test(command)) return {
    rule: "bash-worktree-merge", decision: "deny", reason: "worktree からの gh pr merge は許可されません。",
    suggestion: "Cc の提出ツールから Revisor の審査・マージ経路を使用してください。",
  };
  return null;
};
