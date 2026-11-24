/**
 * カードの持ち主の判定材料を読む adapter (実装メモ 14)。巡回ごとに 2 回の照会で全件を引く。
 * - active なセッション (sessions.status = 'active')
 * - 未解決の confirm_runs と、その PR を出した Cc セッション (Cc の PR 記録 pr_records.author_session_id)
 * 出所は書き換えない (CC-V5-INV-02)。読めなければ throw (呼び手はその巡回で何も捨てない)。
 *
 * @implements spec/feature/control-cards.md — 破棄 (実装メモ 14)
 */
import type Database from "better-sqlite3";
import type { CardOwnership } from "./card-discard-policy.js";

export function readCardOwnership(db: Database.Database): CardOwnership {
  const activeSessions = new Set((db.prepare("SELECT id FROM sessions WHERE status = 'active'").all() as Array<{ id: string }>)
    .map((row) => row.id));
  const owners = new Map<string, string>();
  for (const row of db.prepare(`
    SELECT c.id AS run_id, p.author_session_id AS session_id
      FROM confirm_runs c
      JOIN pr_records p ON p.repo_origin = c.repo_origin AND p.number = c.pr_number
     WHERE c.status IN ('pending', 'confirming') AND p.author_session_id IS NOT NULL
  `).all() as Array<{ run_id: string; session_id: string }>) {
    // 出所キーは inbox の read model と同じ形 (src/inbox/read-model.ts confirmPendingItems)。
    owners.set(`confirm-pending:${row.run_id}`, row.session_id);
  }
  return { activeSessions, confirmPendingOwner: (sourceKey) => owners.get(sourceKey) ?? null };
}
