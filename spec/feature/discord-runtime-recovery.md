---
type: feature
title: "Discord bot runtime recovery"
description: "embedded Discord bot の予期しない停止を遅延再起動し、短時間に停止が集中した場合は in-memory window limit で再起動ループを抑止する。"
service: concordia
domain: runtime-orchestration
tags:
  - discord
  - restart
  - recovery
  - circuit-breaker
  - lifecycle
status: implemented
updated: 2026-07-11
---

# Discord bot runtime recovery

## 目的

Concordia process 内で動く embedded Discord bot が予期せず停止したとき、同じ process を
落とさず bot だけを再起動する。一方、認証不備や継続障害で再起動を繰り返さないよう、短い
時間 window 内の停止回数で circuit breaker をかける。

配線は [`src/bootstrap/core.ts`](../../src/bootstrap/core.ts)、停止回数の決定的判定は
[`src/bootstrap/discord-restart-policy.ts`](../../src/bootstrap/discord-restart-policy.ts)。

## 再起動条件

bot 停止時に次をすべて満たす場合だけ自動再起動を検討する。

- embedded Discord が有効。
- stop status が明示的な `stopped` / `disabled` ではない。
- 既に restart timer が存在しない。

停止時刻を現在 window に追加し、追加後の件数が limit 未満なら delay 後に
`startDiscordBotManaged()` を呼ぶ。起動 result が失敗、または起動 promise が reject した場合は
それ自体を次の stop として同じ policy へ戻す。

limit に到達した stop は再起動せず、`shouldRestart:false`、`limited:true` とする。runtime status
へ suppression message を error として保存し、運用ログにも error を出す。

## 設定

| env | 既定 | 意味 |
|---|---:|---|
| `CONCORDIA_DISCORD_AUTO_RESTART_WINDOW_MS` | `600000` | stop を数える rolling window |
| `CONCORDIA_DISCORD_AUTO_RESTART_LIMIT` | `5` | この件数に到達した stop から suppress |
| `CONCORDIA_DISCORD_AUTO_RESTART_DELAY_MS` | `5000` | restart 実行までの delay |

各値は正の整数として読む。不正値、0、負数は既定値に戻す。policy 単体も `windowMs` と
`limit` を最低 1 に clamp する。

## 状態

policy state は process memory 内の stop timestamp 配列。判定ごとに
`nowMs - windowMs` より古い timestamp を除き、現在 stop を追加する。process 再起動を跨いで
永続化しない。timer は `unref` 可能な runtime では process 終了を妨げない。

## 制約

- breaker は bot の自動復旧だけを止め、Concordia 本体や Slack bot を停止しない。
- limit 到達後に自動 timer を再開する周期処理はない。window 外になった後の新しい stop または
  明示操作が次の契機になる。
- 明示的 stop / disabled は障害回数へ加えず、自動で再起動しない。

## 関連

- [Discord setup](../setup/discord.md)
- [Discord UI](./discord-ui.md)
- [error pipeline](./error-pipeline.md)

