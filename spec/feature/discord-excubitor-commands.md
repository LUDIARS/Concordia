---
type: feature
title: "Discord からの Excubitor project 起動・再起動"
description: "Discord slash command /ex-run と /ex-reboot で Excubitor dashboard project を選び、制御可能 component を逐次 start/restart する。autocomplete は stale-while-refresh cache を使う。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - excubitor
  - slash-command
  - service-control
  - cache
status: implemented
updated: 2026-07-11
---

# Discord からの Excubitor project 起動・再起動

## 目的

Discord から Excubitor dashboard の project を選び、その project に属する実行 component を
Concordia の slash command 経由で起動または再起動する。長い外部制御を interaction handler
内で待ち続けず、先に queue 受付を返信して background task として逐次実行する。

command は [`src/discord/commands/excubitor.ts`](../../src/discord/commands/excubitor.ts)、project
cache は [`src/discord/excubitor-project-cache.ts`](../../src/discord/excubitor-project-cache.ts)、
逐次 queue は [`src/discord/background-task-queue.ts`](../../src/discord/background-task-queue.ts)。

## command

| command | action | 対象 |
|---|---|---|
| `/ex-run project:<code>` | `start` | 現在 state が `running` / `healthy` ではない component |
| `/ex-reboot project:<code>` | `restart` | state にかかわらず制御可能な全 component |

project option は必須で autocomplete 対応。入力は project code / name、および component の
code / name / component field を case-insensitive substring で検索し、最大 25 件を返す。
choice value は `project_code`、表示名は project code と先頭 4 component code を 100 文字以内で
組み立てる。

## component 選択

次をすべて満たす component だけを制御する。

- `disabled !== true`
- `monitor_only !== true`
- runtime が `node` / `dev-process-md` / `app` / `docker-compose` / `docker`
- `ex-run` では state が `running` / `healthy` ではない

component は code 順ではなく project の順序を保ちつつ、`concordia` component だけを最後へ送る。
対象 0 件は外部 request をせず、その旨を interaction reply に返す。

## Excubitor contract

base URL は `CONCORDIA_EXCUBITOR_URL`、次に `EXCUBITOR_URL`、未指定時は
`http://127.0.0.1:17332`。末尾 slash は除く。

- project 取得: `GET /api/v1/projects`
- component 制御: `POST /api/v1/services/:code/control`
- request body: `{ action: "start" | "restart" }`
- header: `content-type: application/json`、`x-concordia-actor: discord-command`

project が cache に無い、または初回取得が empty の場合は cache を invalidate して 1 回再取得する。
依然見つからなければ control を行わず error reply。

## project cache

- TTL は 5 分。
- 初回 cache が無い場合、fresh fetch を最大 800 ms 待つ。間に合わなければ empty を返し、refresh
  自体は継続する。
- stale entry があれば即時返し、single in-flight refresh を background で進める。
- fetch timeout は既定 5 秒。failure は warning を残し、既存 stale entry があればそれを返す。
- successful project 一覧は `project_code` で安定 sort する。

## background 実行と応答

interaction は public reply として defer し、対象 component を列挙した `queued` message へ一度
更新する。その後 singleton queue が 1 task ずつ直列実行し、component ごとの `OK/NG` と
stdout / command / error の短い要約で最終 reply を更新する。summary は 1,900 文字以内。

queue task の例外は queue logger に記録し、後続 task を止めない。command が Concordia 自身を
再起動して reply 更新前に connection が閉じた場合、最後の `editReply` failure は best-effort で
無視する。

## 制約

- 外部制御 request の認可は Excubitor 側の contract に依存する。本 command は actor header 以外の
  credential を付けない。
- queue は process memory 内で、Concordia restart を跨いで再開しない。
- `ex-run` / `ex-reboot` は project 全体単位で、利用者が個別 component を選ぶ option は無い。

## 関連

- [Discord setup](../setup/discord.md)
- [Discord control UI](./discord-control-ui.md)
- [managed processes](../interface/service-schema.md)

