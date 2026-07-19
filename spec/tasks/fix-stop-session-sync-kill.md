---
task: fix-stop-session-sync-kill
project: Concordia
kind: 実装
status: done
created: 2026-07-16T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 528
pr_number: 348
actio_task_id: null
memory_links: []
---
# stop-session の同期 taskkill をリクエスト経路から外す

## 目的

`DELETE /v1/sessions/:id` が実測 100〜200 秒 (cc-live.jsonl perf ログ,
duration_ms=108,242〜199,913) かかり、その間イベントループ全体が停止する。
原因は `src/control/stop-session.ts` の `spawnSync("taskkill", ...)` が
HTTP ハンドラおよび reaper (5 分周期) の上で直列同期実行されるため。

## 完了条件

- taskkill 実行が非同期 (spawn + await) になり、イベントループを塞がない。
- reaper の孤児掃除も同期 spawnSync を使わない。
- 既存の stop-session / reaper テストが緑。

## スコープ (編集可ディレクトリ)

- src/control/ (stop-session.ts, reaper.ts とそのテスト)
- src/api/register-core.ts (DELETE ハンドラの await 化が必要な範囲のみ)

## 実装状況 (2026-07-19 追記)

PR #348 で完了条件を全て満たして main にマージ済み: `src/control/stop-session.ts`
`stopSessionByLictorPid` は Windows は `spawn` + `close` イベント待ちの Promise、
POSIX は `process.kill` (同期だが即時 syscall、ブロッキング I/O ではない) に変更。
呼び出し側 4 箇所 (`src/api/register-core.ts` の `/v1/admin/stop-session/:id`、
`src/control/reaper.ts` の孤児 kill、`src/control/lost-session-process-reaper.ts` の
lost Lictor kill) はすべて await/void 化済み。`tests/reaper.test.ts` で
async `stopProcess` を注入したテストが 23 件 green。
Memoria task id 526/527/528/538 の統合対応の一環として 2026-07-19 に再検証:
tsc / vitest (240 files / 1681 tests) / depcruise / build すべて green。
status を pending → done に更新。
