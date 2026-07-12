---
type: feature
title: "Runtime function metrics"
description: "HTTP と主要 Discord callback の call count・成功/失敗・duration を in-memory 集計し、Vestigium event と snapshot API に公開する AOP instrumentation。"
service: concordia
domain: observability
tags:
  - instrumentation
  - metrics
  - aop
  - discord
  - http
  - vestigium
status: implemented
updated: 2026-07-11
---

# Runtime function metrics

## 目的

Concordia の HTTP request と主要 Discord callback の呼び出し回数、成功/失敗、duration を
process 内で集計し、遅い・頻発する・失敗する実行点を function 単位で観測できるようにする。
instrumentation の reporter failure が application 本体の戻り値や例外を変えないことを不変条件と
する。

Concordia 配線は [`src/instrumentation.ts`](../../src/instrumentation.ts)、汎用 runtime / aggregator
は [`lib/aop-metrics/src/index.ts`](../../lib/aop-metrics/src/index.ts)、HTTP install は
[`src/app.ts`](../../src/app.ts)、Discord 配線は [`src/discord/bot.ts`](../../src/discord/bot.ts)。

## 有効化

`CONCORDIA_AOP_METRICS=0` のときだけ無効。それ以外は既定で有効。無効時は middleware / snapshot
route を追加せず、function wrapper は元 function をそのまま返し、method wrapper は no-op restore
handle を返す。

## metric record

各記録は `service`、`domain`、`kind`、`target`、安定 tags、`status`、`duration_ms`、
`error_name`、timestamp を持つ。Concordia は service/domain を `concordia` とし、error message
本文は記録しない。

集計 key は service / domain / kind / target / sort 済み tags。aggregate row は calls、ok、errors、
total/avg/min/max/last duration、last status/time、error name 別件数を持つ。同期関数と Promise-like
関数の両方で成功・失敗を記録し、元の返り値または例外を保持する。

各 completion は Vestigium に level `info`（成功）または `warn`（失敗）、message
`lapilli.function_metric` で送る。reporter の例外は instrumentation 内で握り、処理本体へ伝播させない。

## HTTP instrumentation

全 path の middleware が request duration を測る。HTTP status 500 以上を error とし、throw された
例外も error name を記録して再 throw する。target は `api.<METHOD> <normalized-path>`。

path segment は decimal ID、UUID、24 文字以上の hex をそれぞれ `:id` / `:id` / `:hex` に正規化し、
個別 ID ごとの metric cardinality 増大を防ぐ。

## Discord instrumentation

instrument 対象は client ready、event bus route、message create/ingress、reaction add/remove、
interaction create/dispatch、monitor refresh、PR queue refresh、status reconcile、stale channel sweep。
target は `discord.*` の固定名、kind は `discord`。

## snapshot API

有効時に `GET /v1/instrumentation/functions` を追加する。

| query | 意味 |
|---|---|
| `service` / `kind` / `domain` | aggregate row の完全一致 filter |
| `limit` | 正の整数だけを採用 |
| `sort` | `calls` / `totalMs` / `avgMs` / `maxMs` / `lastAt`。既定 `totalMs` |

response は `generatedAt`、filter 後 row から再集計した totals、sort 済み rows。in-memory state は
process restart で失われる。内部 API `resetFunctionMetrics()` は全 aggregate を消すが、HTTP reset
endpoint は提供しない。

## 制約

- metric aggregation は永続 database ではなく process memory。長期履歴は Vestigium event 側で扱う。
- snapshot の totals は filter と limit 適用後の rows の合計であり、必ずしも process 全体ではない。
- HTTP metric endpoint は `/v1/admin/*` ではないため、app の admin auth middleware 対象外。

## 関連

- [observability setup](../setup/observability.md)
- [error pipeline](./error-pipeline.md)
- [test design](../test/test-design.md)

