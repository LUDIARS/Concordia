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
updated: 2026-09-03
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

## provider 別の usage source

[`src/cost/log-usage.ts`](../../src/cost/log-usage.ts) が provider ごとに一次ソースを選ぶ。

- `claude-code` / `codex-cli`: ローカルの JSONL (`~/.claude/projects` / `~/.codex/sessions`)。
- `codex-sdk` (Satelles): rollout JSONL を書かないので、transcript frame の `codex_usage`
  payload (`transcript_logs`) が唯一の一次ソース。frame の値は turn 単位ではなくスレッド
  累積なので、同一 thread 内では合算せず最大値を採る (`codex-cli` の `total_token_usage` と
  同じ扱い)。1 セッションが複数 thread を持ち得るため、thread ごとの最大値を thread 間で
  合算する。frame ソース (`UsageFrameSource`) を渡されない呼び出しでは「計測不能」= `null`。
- 上記以外 (`gemini-cli` / `local-llm` / `unknown`): 未計測 (`null`)。

### rate-limit の表示と通知

- Codex のコストチャンネル表示は週間枠の残量とリセット時刻だけを出す。互換用の 5H
  フィールドは取得データに残すが表示しない。
- Claude OAuth usage の `limits[]` にある `kind: weekly_scoped` は、モデルまたは surface
  ごとの週間枠として全体週間枠と併記する。Fable / Mythos の枠はモデルサジェストにも使う。
- Discord の活動チャンネルには scoped 週間枠が 80% 以上になった時点で通知する。同じ
  リセット時刻では 1 回だけ通知し、リセット時刻が不明な場合はローカル日付を通知単位にする。
  Discord への送信が失敗した場合は通知済みにせず、次回更新で再試行する。

`codex-sdk` の frame ソースは session 終了時のレポート生成経路 (`runSessionEndFlow` →
`generateReport` の `usageFrames`) にのみ配線済み — `DELETE /v1/sessions/:id` と
`POST /v1/admin/stop-session/:id` の両方が `transcript_logs` repo を渡す。
それ以外の経路は frame ソースを持たないため `codex-sdk` を未計測扱いにする (既知の範囲)。
表れ方は 2 通りある。

- `null` (計測不能として行/バッジを省く): 状態カード / chat read model
  (`getSessionStatusSnapshot` の cost badge)、`POST /v1/reports/:id/regenerate`。
- `0` (合算時に 0 トークンとして畳む): channel cost・usage sampler・子会社 budget
  (`readSessionUsage(s)?.total ?? 0` 経路)。

frame は新しい順に上限 (既定 500) まで読む。累積値は新しいほど大きいので現行 thread の
最大値は必ず窓に入るが、usage frame が上限を超える長大セッションでは古い thread が
窓から落ちて過少計上になり得る (概算表示なので許容)。

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
