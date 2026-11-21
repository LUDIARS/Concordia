import type { NumberedMigration } from "./migrator.js";

/**
 * 委託 run と session を結び付けるための、 sessions.metadata の式索引
 * (spec/plan/2026-11-21-cc-full-scan-elimination.md FS-13、 CC-SCAN-04)。
 *
 * `GET /v1/delegation/runs` は metadata への LIKE で sessions の全行をなめ、 1 回 0.6〜2.2 秒止めていた。
 * 表示する run の分だけを索引で引けるよう、 delegation_run_id と delegation_call_name の式に索引を張る。
 *
 * - 壊れた JSON の行が実在するため、 json_extract は必ず json_valid の CASE で守る (守らないと INSERT ごと落ちる)。
 * - 照会側 (sessions-repo.ts の DELEGATION_RUN_ID_EXPR / DELEGATION_CALL_NAME_EXPR) は字句まで同じ式を使う。
 *   ここでは共有定数を import せずリテラルで書く。 checksum は source しか見ないので、 定数を後で変えると
 *   適用済みの索引と意味が黙ってずれるため。
 */
export const delegationSessionLinkIndexMigration: NumberedMigration = {
  version: 155,
  name: "delegation-session-link-index",
  source: "sessions.metadata の delegation_run_id / delegation_call_name 式索引 (json_valid で保護、CC-SCAN-04 FS-13) v1",
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_delegation_run ON sessions((
        CASE WHEN json_valid(metadata) THEN
          CASE WHEN json_type(metadata, '$.delegation_run_id') = 'text'
            THEN NULLIF(trim(json_extract(metadata, '$.delegation_run_id')), '')
          END
        END
      ));
      CREATE INDEX IF NOT EXISTS idx_sessions_delegation_call ON sessions((
        CASE WHEN json_valid(metadata) THEN
          CASE WHEN json_type(metadata, '$.delegation_call_name') = 'text'
            THEN NULLIF(trim(json_extract(metadata, '$.delegation_call_name')), '')
          END
        END
      ), started_at);
    `);
  },
};
