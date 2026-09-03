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
updated: 2026-08-03
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
handle を返し、集約サマリ timer も張らない。

`CONCORDIA_AOP_METRICS_STREAM=1` のとき、全 record を per-record で Vestigium へ流す旧挙動に戻し、
集約サマリ timer は張らない。短期デバッグ用の opt-in。

## metric record

各記録は `service`、`domain`、`kind`、`target`、安定 tags、`status`、`duration_ms`、
`error_name`、timestamp を持つ。Concordia は service/domain を `concordia` とし、error message
本文は記録しない。

集計 key は service / domain / kind / target / sort 済み tags。aggregate row は calls、ok、errors、
total/avg/min/max/last duration、last status/time、error name 別件数を持つ。同期関数と Promise-like
関数の両方で成功・失敗を記録し、元の返り値または例外を保持する。

reporter の例外は instrumentation 内で握り、処理本体へ伝播させない。

## Vestigium 出力

Vestigium への書き出しは per-record ストリームと集約サマリの 2 系統。

| 系統 | message | level | 条件 |
|---|---|---|---|
| per-record | `lapilli.function_metric` | `warn` | status `error` の record。既定で `error` のみ |
| per-record | `lapilli.function_metric` | `info` | status `ok` の record。`CONCORDIA_AOP_METRICS_STREAM=1` のときだけ |
| 集約サマリ | `lapilli.function_metric.summary` | `info` | 60 秒間隔。既定 (stream 無効時) のみ |

成功 record を per-record で流すと秒 10 行を超え、log 集積と scan 圧が膨らむため、既定では
in-memory 集計と 60 秒サマリ 1 行に畳む。成功 record を落としても aggregate と snapshot API の
値は変わらない（reporter と aggregator は独立）。

集約サマリの ctx は `interval_ms`、前回サマリからの新規 call 数 `since_last_calls`、process 起動
からの累計 `totals`、call 数上位 20 target の aggregate row `top`。totals は limit 適用前の全 row
から取るため process 全体の値。**前回サマリから新規 call が無い interval では何も出さない**
（aggregate は累計なので、無風区間で同一内容が積もるのを防ぐ）。summary timer は `unref` 済で
process 終了を妨げず、内部の例外は握り潰して host へ伝播させない。

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
process restart で失われる。内部 API `resetFunctionMetrics()` は全 aggregate と集約サマリの基準値を
消すが、HTTP reset endpoint は提供しない。

## 制約

- metric aggregation は永続 database ではなく process memory。長期履歴は Vestigium event 側で扱う。
- snapshot の totals は filter と limit 適用後の rows の合計であり、必ずしも process 全体ではない。
- HTTP metric endpoint は `/v1/admin/*` ではないため、app の admin auth middleware 対象外。

## 契約テストの境界

Vestigium 出力契約を検証するテストは、親プロセスの `CONCORDIA_AOP_METRICS` と
`CONCORDIA_AOP_METRICS_STREAM` のどちらにも依存させない。テスト内で前者を `1`（有効）、後者を
`0`（既定の error のみ per-record）に固定してから instrumentation module を fresh import し、
終了時に元の環境値と module cache を復元する。これは `observability` ドメインの出力契約だけを
検証するための隔離であり、本番で `CONCORDIA_AOP_METRICS=0` を指定したときの無効化契約や業務
ロジックを変更しない。

## イベントループ停止時の被疑者記録

イベントループが止まっている間はログを書けないため、停止の記録は明けた直後の
`event loop stalled` 1 行だけになる。lag と handle 数では **誰が止めたか** が残らず、
事後にはログの空白から推測するしかない。

HTTP middleware は処理中のリクエストを台帳に載せ、停止監視は復帰後の検知時点に未完了な
リクエストのスナップショットを `event loop stalled` に添える。経過時間の長い順に上限件数だけ
出し、全体数は別に添える
(ログ 1 行の肥大を避けつつ、絞られたことを読み手に伝える)。path は資格情報を redact し、
異常に長い request target は上限長で切ってから台帳へ保持する。

これは因果の証明ではなく相関材料である。timer / 定期ジョブによる停止中にも HTTP リクエストは
未完了になり得る一方、同期 HTTP handler は監視 timer の発火前に完了して台帳から消え得る。
台帳が空だったことも切り分け材料にはするが、それだけで原因を断定しない。

## 関連

- [observability setup](../setup/observability.md)
- [error pipeline](./error-pipeline.md)
- [test design](../test/test-design.md)
