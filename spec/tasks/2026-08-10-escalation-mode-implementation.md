---
task: escalation-mode-implementation
project: Concordia
kind: 実装
created: 2026-08-10
memory_links: []
---
# エスカレーションモードを実装する

## 目的

エスカレーションモードの feature spec を新設し、API・DB・停止 claim の配送・ワークフローパケットの
差し替えを実装する。定義と実装が無ければインフラ停止時に規律を外す根拠が無く、外した記録も残らないため、
今のところ「詰まったら各セッションが個別に判断する」状態のままになっている。

Revisor 側の対になる仕組み (CLI 限定バイパスマージ、`Revisor spec/feature/daemonless-cli.md`) は
実装済みでマージ済み。片側だけでは詰まりは解けない。

## 完了条件

- `POST /v1/sessions/:id/escalation { reason }` / `DELETE /v1/sessions/:id/escalation { note }` が動く。
  `reason` が空なら 400 で拒否する。
- `sessions.escalation_mode` と `escalation_events` (session_id / actor / reason / started_at /
  ended_at / note) が永続化される。migration 番号は未マージブランチも含めて確認してから取る。
- 開始時、**他のエスカレーションセッションを除く**全 active セッションへ作業停止 claim が
  pending task の優先扱いで配送される。エスカレーションセッション同士は止め合わない。
- 解除時に停止 claim が取り下げられる。**Cc 停止中に未配送だった claim を、復帰後に遅延配送して
  停止させない**こと。
- エスカレーション中のセッションへ注入されるワークフローパケットが、task 登録要求と worktree 要求を
  外し、本ブランチの直接操作を許す内容に差し替わる。
- 外れないものが外れていない: GitHub 直 push / GitHub PR 作成・マージの禁止、実 finding を出した
  セキュリティスキャンによる停止、他セッションの変更の破棄や共有 checkout の巻き戻しの禁止。
- Cc が応答できない場合の transcript record 宣言を、復帰後の tick が取り込んで同じ内容の
  `escalation_event` を作る。
- セッション文脈パケットと harness status card がエスカレーション中であることを表示する。
- unit/API テストで開始・解除の入力検証と永続化、停止 claim の対象・取消、停止中の未配送 claim の
  破棄、復帰後の transcript record 取り込み、ワークフローパケットの差し替えを担保する。

## スコープ (編集可ディレクトリ)

- `src/api/sessions/`
- `src/db/` (migration + schema)
- `src/control/` (停止 claim の配送・セッション文脈)
- `src/harness/` (status card)
- `spec/feature/escalation-mode.md` (新設: 仕様と実装状況)
