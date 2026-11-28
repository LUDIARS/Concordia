/**
 * 検索要求の台帳 (spec/feature/slack-knowledge-search.md KS-2)。
 *
 * 要求の同一性は (team, channel, 起点 ts) または ワークフローの実行 ID。 同じ鍵は 1 回だけ受け付け、
 * 再送では既存の要求を返す。 状態: received → answered / no_hits / failed / usage。
 * SRP: knowledge_search_requests の読み書きだけ。
 */

import type { Database } from "better-sqlite3";

export type SearchRequestState = "received" | "answered" | "no_hits" | "failed" | "usage";

export interface SearchRequest {
  id: number;
  requestKey: string;
  query: string;
  state: SearchRequestState;
}

export function knowledgeSearchRequestStore(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_search_requests (
    id INTEGER PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, channel TEXT NOT NULL, thread_ts TEXT,
    user_id TEXT, query TEXT NOT NULL, state TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
    error TEXT, trial_context TEXT, received_at INTEGER NOT NULL, finished_at INTEGER)`);
  const insert = db.prepare(`INSERT OR IGNORE INTO knowledge_search_requests
    (request_key, channel, thread_ts, user_id, query, state, received_at) VALUES (?, ?, ?, ?, ?, 'received', ?)`);
  const byKey = db.prepare("SELECT id, request_key, query, state FROM knowledge_search_requests WHERE request_key = ?");
  const finish = db.prepare("UPDATE knowledge_search_requests SET state = ?, hits = ?, error = ?, finished_at = ? WHERE id = ? AND state = 'received'");
  const saveTrial = db.prepare("UPDATE knowledge_search_requests SET trial_context = ? WHERE id = ?");
  const readTrial = db.prepare("SELECT trial_context FROM knowledge_search_requests WHERE id = ? AND state = 'answered'");
  const toRequest = (row: { id: number; request_key: string; query: string; state: SearchRequestState }): SearchRequest =>
    ({ id: row.id, requestKey: row.request_key, query: row.query, state: row.state });
  return {
    /** 要求を保存する。 新規なら created=true。 既にあれば保存済みの要求を返す。 */
    claim(input: { requestKey: string; channel: string; threadTs: string | null; userId: string | null; query: string; nowSec: number }): { created: boolean; request: SearchRequest } {
      const result = insert.run(input.requestKey, input.channel, input.threadTs, input.userId, input.query, input.nowSec);
      const row = byKey.get(input.requestKey) as { id: number; request_key: string; query: string; state: SearchRequestState };
      return { created: result.changes === 1, request: toRequest(row) };
    },
    finish(id: number, state: Exclude<SearchRequestState, "received">, hits: number, error: string | null, nowSec: number): void {
      finish.run(state, hits, error, nowSec, id);
    },
    /** 「セッションを起動して試す」に渡すナレッジのコンテキストを保存する (KS-11)。 */
    saveTrialContext(id: number, context: string): void {
      saveTrial.run(context, id);
    },
    /** 回答済みの要求の試すためのコンテキスト。 無ければ null。 */
    trialContext(id: number): string | null {
      return (readTrial.get(id) as { trial_context: string | null } | undefined)?.trial_context ?? null;
    },
  };
}
export type KnowledgeSearchRequestStore = ReturnType<typeof knowledgeSearchRequestStore>;
