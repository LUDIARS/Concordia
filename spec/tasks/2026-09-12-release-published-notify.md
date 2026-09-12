# Revisor 公開リリースを Concordia Bot で通知する

## 目的

Revisor が公開した major/minor Release を、Concordia が `(repository, tag)` ごとに一度だけ HQ の専用 Discord チャンネルへ配送できるようにする。Revisor はイベント送信だけを担い、通知先と Discord Bot 配送の所有者は Concordia とする。

## 完了条件

- `POST /v1/events/release-published` は既存の loopback dispatch と同じ認可で受信する。
- `release_notice_ledger` が `(repository, tag)` の再送を抑止する。
- `discord.release_notify_channel_id` が設定可能で、未設定時は配送せず 202 と記録する。
- 本文は title、最大 10 行の notice、Release URL で構成し、Discord の mention を全て無効化する。
- 純粋な compose/decide と SQLite/Bot runtime を分離し、正常・重複・未設定・Bot 失敗を fixture で検証する。

## ドメインと不変条件

- 価値 ID: UX-CC-W3 / UX-CC-W4
- シナリオ: 公開済み Release を通知し、同じイベントの再送で通知を増やさない。
- 状態所有者: `release_notice_ledger` は受理済み `(repository, tag)` を所有し、Discord 設定は通知先を所有する。
- 不変条件: CC-INV-03（再送は配送を増やさない）、CC-INV-06（配達失敗を配達済みにしない）。
