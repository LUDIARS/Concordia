---
task: handover-command
project: Concordia
kind: 実装
created: 2026-08-14
memory_links:
  - spec/feature/session-compaction.md
---
# /co-handover — 次セッションへの移行 (自動引き継ぎ)

## 目的
「次のセッションに移行する (自動引き継ぎする) パターンのコマンド」(neco 2026-08-13)。
/co-compaction は同一セッションで /clear して続行、/co-relictor は Lictor 更新目的の再起動
(切り離し生成 handoff)。作業を新しいセッションへ移す入口が無いので作る。

## 完了条件
- `POST /v1/sessions/:id/handover` — セッション自身に引き継ぎ資料を書かせ (compaction と
  同じ自筆 elicit、失敗時は切り離し生成へフォールバック)、チャンネルへ投稿 → 同 cwd で
  新セッションを spawn → 旧セッションを終了する。
- 新セッション登録時に handoff が inject され、文言は「移行」である (relictor の
  「Lictor 再起動」文言と区別)。goal も引き継がれる。
- Discord `/co-handover` コマンドから起動できる。
- Discord からの実行は session spawn・session end の両権限を要求する。
- relictor と機構 (pending 登録 / spawn / 終了 / 保険 kill) を共有し、複製しない。
- pending は spawn enrollment ID で後継登録と一意に結び、同 cwd の別 session に
  handoff を誤投入しない。同期 spawn 失敗時は pending を破棄する。
- 同一 session の relictor / handover が進行中なら、重複要求は 409 で拒否する。
- ルート一覧・コマンド登録・権限・pending kind/enrollment・handoff/goal 復元のテストが green。

## スコープ (編集可ディレクトリ)
- src/api/sessions/
- src/control/
- src/discord/
