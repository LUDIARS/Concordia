import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "../../tests/helpers/db.js";

/**
 * 全件走査に戻らないための EXPLAIN QUERY PLAN の固定 (spec/plan/2026-11-21-cc-full-scan-elimination.md CC-SCAN-01)。
 * 統計 (sqlite_stat1) の無い DB では、 メモリ DB の計画が live と一致する (37 本で確認済み)。
 * 統計を入れる段階 (S3) では、 代表的な stat1 を入れた版をここに足す。
 */
let db: Database.Database;
beforeEach(() => { db = makeTestDb(); });

function plan(sql: string, ...args: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
    .map((row) => row.detail).join("\n");
}

const RUN_ID_EXPR = `(
        CASE WHEN json_valid(metadata) THEN
          CASE WHEN json_type(metadata, '$.delegation_run_id') = 'text'
            THEN NULLIF(trim(json_extract(metadata, '$.delegation_run_id')), '')
          END
        END
      )`;
const CALL_NAME_EXPR = RUN_ID_EXPR.replaceAll("delegation_run_id", "delegation_call_name");

describe("session_events (session_id, kind) lookups", () => {
  const cases: Array<[string, string, unknown[]]> = [
    ["eventsByKind", "SELECT * FROM session_events WHERE session_id = ? AND kind = ? ORDER BY ts DESC, id DESC", ["s", "inject"]],
    ["lastEventTsByKind", "SELECT ts FROM session_events WHERE session_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1", ["s", "prompt"]],
    ["parentReceivedRunTerminal (core.ts)",
      "SELECT 1 FROM session_events WHERE session_id = ? AND kind = 'inject' AND json_extract(payload, '$.source') = ? LIMIT 1",
      ["s", "x"]],
    ["latestEventsByKind",
      `SELECT e.* FROM session_events e
        WHERE e.kind = ? AND e.session_id IN (?, ?)
          AND e.id = (SELECT e2.id FROM session_events e2
                       WHERE e2.session_id = e.session_id AND e2.kind = ?
                       ORDER BY e2.ts DESC, e2.id DESC LIMIT 1)
        ORDER BY e.ts DESC, e.id DESC`,
      ["prompt", "a", "b", "prompt"]],
  ];
  for (const [name, sql, args] of cases) {
    it(`${name} uses idx_events_session_kind_ts`, () => {
      const detail = plan(sql, ...args);
      expect(detail).toContain("idx_events_session_kind_ts");
      expect(detail).not.toContain("idx_events_kind ");
      expect(detail).not.toMatch(/SCAN session_events(?! USING)/);
    });
  }

  it("drops the low-selectivity kind index", () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_kind'`).get();
    expect(row).toBeUndefined();
  });
});

describe("delegation session link lookups", () => {
  it("finds sessions by delegation_run_id through the expression index", () => {
    const detail = plan(`SELECT * FROM sessions WHERE ${RUN_ID_EXPR} IN (SELECT value FROM json_each(?))`, "[]");
    expect(detail).toContain("SEARCH sessions USING INDEX idx_sessions_delegation_run");
  });

  it("finds legacy sessions by call name and start time through the expression index", () => {
    const detail = plan(
      `SELECT * FROM sessions WHERE ${CALL_NAME_EXPR} = ? AND started_at BETWEEN ? AND ? AND ${RUN_ID_EXPR} IS NULL`,
      "impl", 1, 2,
    );
    expect(detail).toContain("SEARCH sessions USING INDEX idx_sessions_delegation_call");
  });

  it("still accepts malformed metadata because the expressions are guarded by json_valid", () => {
    expect(() => db.prepare(
      `INSERT INTO sessions (id, provider, repo_path, host, started_at, status, last_seen_at, metadata)
       VALUES ('bad', 'codex-cli', 'C:/r', 'h', 1, 'active', 1, '{not json')`,
    ).run()).not.toThrow();
    expect(() => db.prepare(`UPDATE sessions SET metadata = '{still not json' WHERE id = 'bad'`).run()).not.toThrow();
  });
});
