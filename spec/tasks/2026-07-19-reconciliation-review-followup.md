---
task: reconciliation-review-followup-20260719
project: Concordia
kind: 実装
status: pending
created: 2026-07-19T00:00:00.000Z
source_session: lictor-c23315c1-37f4-42f5-82e3-b14802c17871
memoria_task_id: 570
actio_task_id: null
memory_links:
  - review/Concordia/2026-07-19/
  - review/Concordia/reconciliation-latest.json
---
# 2026-07-19 突合レビュー対応 (Concordia)

## 目的
daily-review-reconciliation (2026-07-19, HEAD f9f7a42→db7f291) で検出された未解消・新規の指摘に対応する。

## 完了条件
- [x] **high/両者一致 (Issue #369)**: `src/api/sessions/lifecycle.ts:392` — DELETE /v1/sessions/:id が status=lost のセッションに `session_end_pending_at` を立てず ended へ遷移させ、reaper が ended を恒久保護するためプロセスツリーがどの経路からも回収されない。https://github.com/LUDIARS/Concordia/issues/369
  → 2026-08-31 に現状コードで再確認し解消。詳細は `spec/tasks/2026-08-31-reconciliation-review-followup-recheck.md`。
- [x] **high**: `src/control/provider-preset.ts:221` — `network_access=false` 指定が無言で ignore され、デフォルトのネットワーク許可で Codex delegation が起動する。
  → 2026-08-31 に現状コードを確認したところ既に対応済み (`isNetworkAccessDisabled` 検出 + warn ログ)。
- [ ] **high**: `src/api/sessions/end.ts:113` — 遅延到着する session-end 完了処理が、同 ID で再開済みのセッションを誤って停止させうる (DELETE → 同ID再登録 → 遅延 session-end-done の競合)。
- [ ] **high**: `src/control/lost-session-process-reaper.ts:70` — lost-session reaper の最終安全確認が古い processByPid スナップショットを再利用し、PID 再利用時に無関係プロセスを停止しうる。
- [ ] `src/slack/session-channel-archive.ts:65` — archive sweep が row を選択済みの場合、`cancel()` 呼び出しが in-flight の archive を止められない。
- [x] `src/discord/commands/end-session.ts:13` — `/end-session` が Concordia 側 DELETE の結果を待たず常に成功表示する。
  → 2026-08-31 に現状コードで再確認し解消。詳細は `spec/tasks/2026-08-31-reconciliation-review-followup-recheck.md`。
- [ ] `src/discord/bot.ts:986` — Discord メッセージ最適化有効時、Claude セッションの完了フレームが transcript-relay でフィルタされ working タグが固着しうる。
- [ ] (継続, 07-18 から) `src/delegation/service.ts:624,631` — 未着手。
- [ ] (継続, 07-18 から) `src/db/schema.ts:7` — disputed のまま未着手。
- [ ] (継続, 07-18 から, disputed) `src/api/register-core.ts:756` — Codex=未解消 (ok:true を touch 完了前に返す) / Opus=解消 (reportError 追加) で判定割れ。保守的に未解消として継続。

## スコープ (編集可ディレクトリ)
- `src/api/sessions/`, `src/control/`, `src/discord/`, `src/slack/`, `src/delegation/`, `src/db/`
