/**
 * 表示する委託 run に結び付きうる session だけを索引で引く (spec/plan/2026-11-21-cc-full-scan-elimination.md FS-13)。
 *
 * 以前は metadata への LIKE で sessions の全行 (上限 1000 行・metadata 約15MB) を読み、 JS で結び付けていた。
 * ここでは結び付けの規則 (DelegationRunSessionReadModel) は変えず、 その規則が見る候補だけを渡す。
 * 候補は次の和集合で、 どれも read model の判定と同じかそれより広い:
 *   (a) run.child_session_id の PK
 *   (b) metadata.delegation_run_id が表示 run の id のもの (idx_sessions_delegation_run)
 *   (c) delegation_run_id が無く、 call_name が一致し、 開始時刻が run 作成の ±10 分のもの
 *       (idx_sessions_delegation_call。 旧形式の結び付けを使う run の分だけ)
 */

import type Database from "better-sqlite3";
import type { SessionRow } from "../shared/types.js";

/** migration 155 の索引式と字句まで同じにする (式が違うと planner が索引を使わない)。 */
const DELEGATION_RUN_ID_EXPR = `(
        CASE WHEN json_valid(metadata) THEN
          CASE WHEN json_type(metadata, '$.delegation_run_id') = 'text'
            THEN NULLIF(trim(json_extract(metadata, '$.delegation_run_id')), '')
          END
        END
      )`;
const DELEGATION_CALL_NAME_EXPR = `(
        CASE WHEN json_valid(metadata) THEN
          CASE WHEN json_type(metadata, '$.delegation_call_name') = 'text'
            THEN NULLIF(trim(json_extract(metadata, '$.delegation_call_name')), '')
          END
        END
      )`;

/** run-session-read-model.ts の LEGACY_LINK_WINDOW_MS と同じ窓。 */
const LEGACY_LINK_WINDOW_MS = 10 * 60 * 1000;

export interface DelegationRunLinkTarget {
  id: string;
  child_session_id: string | null;
  call_name: string;
  /** run の作成時刻 (ms)。 */
  created_at: number;
  /** 旧形式 (call_name + repo + 時刻) の結び付けを使う run か。 args に対象 repo がある run だけ true。 */
  usesLegacyLink: boolean;
}

export function listDelegationSessionsForRuns(
  db: Database.Database,
  runs: readonly DelegationRunLinkTarget[],
): SessionRow[] {
  if (runs.length === 0) return [];
  const byId = new Map<string, SessionRow>();
  const add = (rows: SessionRow[]): void => {
    for (const row of rows) byId.set(row.id, row);
  };

  const childIds = runs.map((run) => run.child_session_id).filter((id): id is string => Boolean(id));
  if (childIds.length > 0) {
    add(db.prepare(`SELECT * FROM sessions WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(childIds)) as SessionRow[]);
  }

  add(db.prepare(`SELECT * FROM sessions WHERE ${DELEGATION_RUN_ID_EXPR} IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(runs.map((run) => run.id))) as SessionRow[]);

  // call_name ごとに窓をまとめ、 run ごとの照会 (N+1) にしない。
  const windows = new Map<string, { from: number; to: number }>();
  for (const run of runs) {
    if (!run.usesLegacyLink) continue;
    const current = windows.get(run.call_name);
    const from = run.created_at - LEGACY_LINK_WINDOW_MS;
    const to = run.created_at + LEGACY_LINK_WINDOW_MS;
    windows.set(run.call_name, current
      ? { from: Math.min(current.from, from), to: Math.max(current.to, to) }
      : { from, to });
  }
  const legacy = db.prepare(
    `SELECT * FROM sessions
      WHERE ${DELEGATION_CALL_NAME_EXPR} = @callName
        AND started_at BETWEEN @startedAfter AND @startedBefore
        AND ${DELEGATION_RUN_ID_EXPR} IS NULL`,
  );
  for (const [callName, window] of windows) {
    // started_at は秒。 read model は started_at * 1000 を ms の窓と比べるので、 内側へ丸める。
    add(legacy.all({
      callName,
      startedAfter: Math.ceil(window.from / 1000),
      startedBefore: Math.floor(window.to / 1000),
    }) as SessionRow[]);
  }

  return [...byId.values()];
}
