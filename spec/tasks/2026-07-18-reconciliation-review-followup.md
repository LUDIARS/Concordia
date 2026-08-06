---
task: reconciliation-review-followup-20260718
project: Concordia
kind: 実装
status: done
created: 2026-07-18T00:00:00.000Z
source_session: lictor-9515e0e8-4389-4b30-bd4e-0bbe330e3bfc
memoria_task_id: 554
actio_task_id: null
memory_links:
  - review/Concordia/2026-07-18/
  - review/Concordia/2026-07-19/
---
# 2026-07-18 突合レビュー対応 (Concordia)

## 目的
daily-review-reconciliation (2026-07-18, HEAD 8c9f67a→f9f7a42) で検出された未解消・新規の指摘に対応する。

## 完了条件
2026-07-19 の突合レビューで実コード照合し解消状況を確定 (詳細: `spec/tasks/2026-07-19-reconciliation-review-followup.md`)。

- [x] `src/control/spawner.ts:167` — cmd.exe コマンドインジェクション。`escapeCmdArg` によるエスケープで解消確認済み。
- [x] `src/discord/bot.ts:240` — forum spawn の subsidiary 判定なし。`subsidiary_id` 配線で解消確認済み。
- [ ] `src/delegation/service.ts:624,631` — 未着手 (service.ts は 07-19 時点でも無変更)。07-19 タスクへ継続。
- [x] `src/api/delegation.ts:565` — 無条件 `{ok:true}` 返却。`ws_clients<=0` で 409 ガードにより解消確認済み。
- [x] `src/delegation/seed.ts:562` — custom template による既定 forum_tag 上書き。既定+customマージへ変更し解消確認済み。
- [ ] `src/db/schema.ts:7` — disputed のまま未着手。07-19 タスクへ継続。
- [x] `src/slack/bot.ts:457` — セッション再開時の archive 誤取消。`archiveLifecycle.cancel` 呼び出しで解消確認済み。
- [x] `src/slack/session-channel-routing.ts:28` — 終了済みセッションへの無検査投入。`isSessionActive` ガードで解消確認済み。
- [x] `src/discord/error-monitor.ts:72` — poll 重複 report。`runInFlight` 共有 promise で解消確認済み。
- [~] `src/api/register-core.ts:756` — disputed (Codex=未解消/Opus=解消)。保守的に未解消として 07-19 タスクへ継続。

## スコープ (編集可ディレクトリ)
- `src/control/`, `src/discord/`, `src/delegation/`, `src/api/`, `src/slack/`, `src/db/`
