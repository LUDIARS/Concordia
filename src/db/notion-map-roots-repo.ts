/**
 * Notion 記事マップの起点ごとの状態とまとめ・全体の概観の永続 (spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」、 migration 143)。
 * - 起点: ページ数・除外数・最終取得・失敗理由・まとめ (と作ったときの配下の指紋)
 * - 概観: マップ全体 (notion_map_meta の `overview`)
 * ページと辺は notion-map-repo.ts。
 */

import type Database from "better-sqlite3";
import type { NotionMapOverview, NotionMapRootState } from "../rules/notion-map-types.js";

export class NotionMapRootsRepo {
  constructor(private readonly db: Database.Database) {}

  root(rootId: string): NotionMapRootState | null {
    return (this.db.prepare(`SELECT root_id, title, pages, excluded, last_attempt_at, last_success_at, last_error, summary, summary_basis
      FROM notion_map_roots WHERE root_id = ?`).get(rootId) as NotionMapRootState | undefined) ?? null;
  }

  roots(): Array<NotionMapRootState & { summary_attempted_at: number | null }> {
    return this.db.prepare(`SELECT * FROM notion_map_roots ORDER BY root_id`).all() as Array<NotionMapRootState & { summary_attempted_at: number | null }>;
  }

  markRootAttempt(rootId: string, at: number): void {
    this.db.prepare(`
      INSERT INTO notion_map_roots (root_id, last_attempt_at) VALUES (?, ?)
      ON CONFLICT(root_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
    `).run(rootId, at);
  }

  markRootSuccess(rootId: string, input: { title: string; pages: number; excluded: number }, at: number): void {
    this.db.prepare(`
      INSERT INTO notion_map_roots (root_id, title, pages, excluded, last_attempt_at, last_success_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(root_id) DO UPDATE SET title = excluded.title, pages = excluded.pages, excluded = excluded.excluded,
        last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_error = NULL
    `).run(rootId, input.title, input.pages, input.excluded, at, at);
  }

  /** 失敗理由だけを残す。 ページ・辺・まとめは前回のまま。 */
  markRootFailure(rootId: string, error: string, at: number): void {
    this.db.prepare(`
      INSERT INTO notion_map_roots (root_id, last_attempt_at, last_error) VALUES (?, ?, ?)
      ON CONFLICT(root_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error
    `).run(rootId, at, error);
  }

  setRootSummary(rootId: string, summary: string, basis: string, at: number): void {
    this.db.prepare(`UPDATE notion_map_roots SET summary = ?, summary_basis = ?, summary_attempted_at = ? WHERE root_id = ?`)
      .run(summary, basis, at, rootId);
  }

  markRootSummaryFailed(rootId: string, at: number): void {
    this.db.prepare(`UPDATE notion_map_roots SET summary_attempted_at = ? WHERE root_id = ?`).run(at, rootId);
  }

  overview(): NotionMapOverview | null {
    const row = this.db.prepare(`SELECT value FROM notion_map_meta WHERE key = 'overview'`).get() as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as NotionMapOverview;
    } catch {
      return null;
    }
  }

  setOverview(overview: NotionMapOverview): void {
    this.db.prepare(`
      INSERT INTO notion_map_meta (key, value, updated_at) VALUES ('overview', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(overview), overview.generated_at);
  }

  /** 設定から外れた起点の状態を消す。 */
  dropExcept(rootIds: readonly string[]): void {
    const keep = new Set(rootIds);
    const del = this.db.prepare(`DELETE FROM notion_map_roots WHERE root_id = ?`);
    this.db.transaction(() => {
      for (const r of this.roots()) if (!keep.has(r.root_id)) del.run(r.root_id);
    })();
  }
}
