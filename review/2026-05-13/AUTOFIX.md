# Concordia — AUTOFIX (2026-05-13)

ソースコード自動修正は **行わない** (autofix_count=0). 列挙のみ.

候補 (安全圏内, 手動で着手する場合):

| # | 対象 | 種別 | 概要 |
|---|------|------|------|
| 1 | `README.md:53` | docs | F4 の「5 分間 heartbeat 無し」を「30 分」に修正し `CONCORDIA_LOST_AFTER_SEC` 既定値と整合 |
| 2 | `src/dispatcher.ts:305-312` / `src/api/sessions.ts:425-456` / `src/api/personas.ts:20-24` / `src/api/chat.ts:140-142` | refactor | `safeParse` / `parseMeta` / `nowSec()` を `src/shared/util.ts` に集約 |
| 3 | `src/api/sessions.ts:336-353` | refactor | DELETE /v1/sessions/:id の chat post 経路を `src/api/chat.ts:31-69` と共通化 |
| 4 | `src/api/ws.ts:35` | hardening | `wss.on("connection", (ws, req) => ...)` で `req.headers.host` / `req.socket.remoteAddress` を loopback 限定 check |
| 5 | `src/api/processes.ts:18-26` | hardening | `command` を allow-list / pattern check, または `Origin` header 検証 |
| 6 | `spec/multi-provider.md:178` | docs | 言及されている `docs/contributing-provider.md` を新設 (or 言及を削除) |
| 7 | `src/shared/config.ts:38` | cleanup | `anthropicApiKey` を `src/report/generator.ts` の fallback 経路に配線, または config から削除 |
| 8 | `src/processes/runner.ts:64-66` | hardening | `error_patterns` の各 RegExp を `safe-regex` 等で reject (catastrophic backtracking 防止) |
| 9 | `src/rules/handler.ts:130-149` | hardening | `remove_rule` の rate-limit (例: 5 分 1 件 cap) を追加 |
| 10 | `src/rules/engine.ts:107-148` / `src/rules/proposer.ts:122-138` | refactor | `extractJson()` / `parseJson()` の重複を `src/rules/json-extract.ts` に集約 |

autofix_count=0. 上記は次の手動 PR (もしくは指示があれば次セッションで) で着手する候補.
