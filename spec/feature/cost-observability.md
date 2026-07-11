---
type: feature
title: "Session cost observability"
description: "Concordia が管理するセッションの token/cost を本社・子会社・Discord channel・provider・時系列・one-shot 単位で集計し、Web/API と日次予算 kill switch に公開する。"
service: concordia
domain: observability
tags:
  - cost
  - tokens
  - observability
  - timeseries
  - budget
  - api
status: implemented
updated: 2026-07-11
---

# Session cost observability

## 目的

Concordia 自身が管理する agent sessions の context / token cost を、本社・子会社・Discord
channel・provider・時刻 bucket ごとに可視化する。別サービスが push する `/v1/cost-feed` とは
別系統で、Web の cost page と Discord monitor の集計元になる。

HTTP 境界は [`src/api/cost.ts`](../../src/api/cost.ts)、route 配線は
[`src/api/register-cost.ts`](../../src/api/register-cost.ts)。
時系列の累積差分集計は
[`src/cost/usage-timeseries.ts`](../../src/cost/usage-timeseries.ts)、sample 起点 overview は
[`src/cost/sample-overview.ts`](../../src/cost/sample-overview.ts) が担当する。

## overview

`GET /v1/cost/overview` は `{ windows, channels }` を返す。

- `windows.daily`: local midnight から現在までの本社・子会社別 token 使用量と日次 budget。
- `windows.weekly`: 直近 7 日相当の本社・子会社別 token 使用量。
- `channels`: active session の Discord channel、provider、現在 context tokens、累積 cost tokens。

overview source は runtime 配線で `live` または `samples`。`live` は provider logs を memoized
reader で読む。`samples` は `cost_usage_samples` の累積値の正の差分を集計する。子会社 ID が
既知一覧に無い sample は子会社集計へ入れず、`subsidiary_id` が無い sample は本社へ入れる。

## 時系列

`GET /v1/cost/timeseries` は `since`（epoch 秒、既定 24 時間前）と `bucket`（秒、既定 600）を
受ける。各 bucket は distinct sessions、context token snapshot の合計、session ごとの累積
`cost_tokens` の正の差分 `spentTokens` を持つ。各 session の初回 sample は baseline とし、
過去累積を初回 bucket へ計上しない。provider 別配列も同時に返す。

`GET /v1/cost/limit-timeseries` は `since`（既定 7 日前）以降の保存 sample に現在取得値を
加え、provider の rate-limit 使用率と reset 時刻の系列を返す。

## one-shot calls

長寿命 session 外の LLM 呼び出しは `/v1/cost/one-shots` で記録・参照する。

- `POST`: `service`、`provider`、`prompt` 必須。status は `ok/error/timeout`、それ以外は
  `unknown`。input/output/total tokens、USD cost、command/model/cwd、metadata を保存する。
- `GET`: `limit` 既定 100 と `since`（epoch milliseconds、既定 24 時間前）を受け、recent
  calls と service/provider 別 summary を返す。

prompt は永続化され、GET response にも含まれる。secret や個人データを prompt へ含めない。

## 日次 budget

`GET /v1/admin/cost-budget` は設定値、当日 tokens、blocked、date を返す。
`PUT /v1/admin/cost-budget` は有限 number の `daily_token_budget` を設定し、`0` は無効化。
admin path は app の admin auth middleware 配下にある。

budget 超過時の dispatch 停止は runtime の `costStatus.blocked` を各 chat/delegation 経路が参照して
実施する。本 API は状態の設定・表示面であり、個々の kill-switch 判定を再実装しない。

## 永続データ

実装上の主な table は `cost_daily_usage`、`cost_log_seen`、`cost_usage_samples`、
`cost_limit_samples`、`cost_one_shot_calls`。DDL の正本は
[`src/db/schema.ts`](../../src/db/schema.ts)。

## 制約

- 時系列の negative delta は provider counter reset とみなし 0 に切る。
- live overview は同期 log I/O を含むが、session/window と channel reader の cache で再読を抑える。
- `overviewSource` は public query では切り替えず、bootstrap の配線で決まる。
- `/v1/cost-feed` の cross-service 集計は本機能の session cost と混同しない。

## 関連

- [data/schema.md](../data/schema.md)
- [setup/observability.md](../setup/observability.md)
- [setup/config-reference.md](../setup/config-reference.md)
- [subsidiary delegation](./subsidiary-delegation.md)
