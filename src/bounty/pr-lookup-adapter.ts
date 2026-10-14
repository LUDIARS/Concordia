/**
 * 修正の PR の辿り方の adapter (spec/feature/bug-bounty.md §6 SPEC-BOUNTY-FIX-LINK)。
 *
 * - セッション → PR: Cc の PR 記録 (pr_records、local PR の提出もここへ載る) のうち、そのセッションが出した、
 *   対象プロジェクトのリポジトリの PR。 新しいものを採る。 番号は Revisor の変更一覧の `pullRequests[].number` と
 *   突き合わせる (§7)。
 * - Actio タスク → セッション: セッションの task-link (metadata `cc_task_links`) にその参照を持つセッション。
 *
 * @implements SPEC-BOUNTY-FIX-LINK
 */

import type Database from "better-sqlite3";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import type { BountyPrLookupPort } from "./ports.js";

const ACTIO_REFERENCE = /^actio:[A-Za-z0-9-]+$/u;
const MAX_SESSIONS = 20;

export function createBountyPrLookup(deps: {
  db: Database.Database;
  /** プロジェクトの repo_origin。 未登録・未設定は null。 */
  repoOrigin(project: string): string | null;
}): BountyPrLookupPort {
  return {
    prOfSession(sessionId, project) {
      const origin = deps.repoOrigin(project);
      if (!origin) return null;
      const target = normalizeRepoOrigin(origin).toLowerCase();
      const rows = deps.db.prepare(
        "SELECT repo_origin, number FROM pr_records WHERE author_session_id = ? ORDER BY created_at DESC LIMIT 50",
      ).all(sessionId) as Array<{ repo_origin: string; number: number }>;
      const match = rows.find((row) => normalizeRepoOrigin(row.repo_origin).toLowerCase() === target);
      return match ? String(match.number) : null;
    },
    sessionsOfTask(taskRef) {
      if (!ACTIO_REFERENCE.test(taskRef)) return [];
      // task-link は JSON の配列。 参照の文字列で候補を絞り、JSON を読んで確かめる。
      const rows = deps.db.prepare(
        "SELECT id, metadata FROM sessions WHERE metadata LIKE ? ORDER BY started_at DESC LIMIT ?",
      ).all(`%${taskRef}%`, MAX_SESSIONS) as Array<{ id: string; metadata: string | null }>;
      return rows.filter((row) => {
        try {
          const links = (JSON.parse(row.metadata ?? "{}") as { cc_task_links?: unknown }).cc_task_links;
          return Array.isArray(links) && links.some((link) =>
            link && typeof link === "object" && (link as { task_reference?: unknown }).task_reference === taskRef);
        } catch {
          return false;
        }
      }).map((row) => row.id);
    },
  };
}
