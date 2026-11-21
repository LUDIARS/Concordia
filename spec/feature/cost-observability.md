---
type: feature
title: "Session cost observability"
description: "Concordia が管理するセッションの token/cost を本社・子会社・Discord channel・provider・時系列・one-shot 単位で集計し、Web/API と日次予算 kill switch に公開する。"
service: concordia
domain: chat-platforms
tags:
  - cost
  - tokens
  - observability
  - timeseries
  - budget
  - api
status: implemented
updated: 2026-09-07
---

# Session cost observability

> 所属ドメイン: [`chat-platforms`](../domains/chat-platforms.domain.json)

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

### Gemini（Antigravity CLI）

Actio: `actio:e586d21d-5b1b-465b-b936-bbec404b10a5`。価値は `UX-CC-W4`（利用量と上限の判断）と `UX-CC-W8`（AI 予算の残量）。`src/cost` の観測層が集計を、セッション登録側が Lictor の会話対応を、各予算が計上済みの状態を所有する。

- **C-1 `decodeAgyGeneration(data)`**。`gen_metadata` の `ChatModelMetadata.usage` は未キャッシュ入力 `.1.4.2`、キャッシュ読み取り `.1.4.5`、思考込み出力 `.1.4.3` を別々に持つ。思考 `.1.4.9` と回答 `.1.4.10` は出力の内訳。モデルは `.1.19`、キャッシュ書き込み `.1.4.4` は別指標として集計対象外。対応は `agy.exe` の Protobuf 定義と既存の隔離検証 DB の数値（出力 19 = 思考 17 + 回答 2）で確認した。
- **C-2 `agySessionGenerations(generations,start,end)`**。Cc の provider `antigravity-cli` に対し、Lictor が起動固有ログ・cwd・presence で確定した会話 ID をセッションに保存する。対応する起動区間の生成だけを帰属させる。会話 ID を検証して正規の `conversations` 直下から読み、古いセッションで対応を取得できない場合は未計測とする。
- **C-3 `accumulateAgyUsageWindows(generations,windows)`**。生成開始時刻（無ければ関連 step の作成時刻）で半開区間に配分する。時刻を取れない行はセッション・期間別計上から省く。トークン値は Discord コストチャンネル、コストレポート、セッションのコスト、Web の使用量時系列、拠点の週間集計、月次・日次予算に使う。

SQLite は worker thread で読み取り専用の WAL スナップショットを取得する。生成メタデータと step メタデータだけを読み、直近 2,048 行、1 行 2 MiB、全体 64 MiB を上限とする。主 DB と WAL の更新時刻・サイズで再読を判定し、失敗した取得は次回に再試行する。上限を超える間隔で増えた場合は過少計上になり得る。

全体の日次予算は会話 DB ごとの `gen_metadata.idx` を前回位置として保ち、初回は位置だけを保存する。2 回目以降は位置より新しい行の消費を当日の観測として一度だけ加える。再試行時は保存済みの位置から続ける。

Neon と Argon のセッション USD は [Google Gemini Developer API の Standard 料金](https://aistudio.google.com/docs/pricing#gemini-4-neon)による換算値。Antigravity の実請求額はこの集計の対象外。価格表にないモデルはトークンを計上して単価不明として表示する。レート枠の取得は既存 provider のみ。

[`src/cost/log-usage.ts`](../../src/cost/log-usage.ts) が provider ごとに一次ソースを選ぶ。

- `claude-code` / `codex-cli`: ローカルの JSONL (`~/.claude/projects` / `~/.codex/sessions`)。
- `codex-sdk` (Satelles): rollout JSONL を書かないので、transcript frame の `codex_usage`
  payload (`transcript_logs`) が唯一の一次ソース。frame の値は turn 単位ではなくスレッド
  累積なので、同一 thread 内では合算せず最大値を採る (`codex-cli` の `total_token_usage` と
  同じ扱い)。1 セッションが複数 thread を持ち得るため、thread ごとの最大値を thread 間で
  合算する。frame ソース (`UsageFrameSource`) を渡されない呼び出しでは「計測不能」= `null`。
- 上記以外 (`gemini-cli` / `local-llm` / `unknown`): 未計測 (`null`)。

### セッション ↔ transcript の対応付け

JSONL を読む provider (`claude-code` / `codex-cli`) では、どのファイルがそのセッションの
ものかを `resolveSessionTranscript` (`src/cost/log-usage.ts`) が唯一の経路として決める。
判定材料は **Lictor が報告した `transcript_path` だけ**で、開始時刻の近さ・cwd 一致・
mtime といった推測は行わず、フォールバックも持たない。報告値は登録 API 由来なので、
provider の正本ルート (`~/.claude/projects` / `~/.codex/sessions`) 配下に symlink 解決後の
実体があるものだけを受け付ける (`resolveTrustedTranscriptPath`)。

報告が無い / 正本ルート外を指す場合は `null` = 推定不能とし、他セッションのログで
埋め合わせない。推測を残していた頃は排他が無いため複数セッションが同一ファイルを掴み、
コンテキスト占有が他人の値になっていた (2026-09-07 実測で claude-code 148 本中 18 本が
誤り。詳細は
[problem log](../plan/problem_logs/2026-09-07-context-estimate-transcript-misattribution.md))。
context 推定 (`context-estimate`) と cost 系 cache (`session-cost` / `session-usage-cache` /
`windowed-usage` / `windowed-usage-cache` / `channel-cost-cache`) は全てこの関数を通す。

### rate-limit の表示と通知

- Codex のコストチャンネル表示は週間枠の残量とリセット時刻だけを出す。互換用の 5H
  フィールドは取得データに残すが表示しない。
- Claude OAuth usage の `limits[]` にある `kind: weekly_scoped` は、モデルまたは surface
  ごとの週間枠として全体週間枠と併記する。Fable / Mythos の枠はモデルサジェストにも使う。
- Discord の活動チャンネルには scoped 週間枠が 80% 以上になった時点で通知する。同じ
  リセット時刻では 1 回だけ通知し、リセット時刻が不明な場合はローカル日付を通知単位にする。
  Discord への送信が失敗した場合は通知済みにせず、次回更新で再試行する。
- 5H 利用率通知も送信成功後にだけ通知済みを記録する。同じ通知キーの同時送信は 1 つの
  in-flight request に集約し、失敗した request は次回更新で再試行できる (`UX-CC-W4`, `CC-INV-06`)。
- cost status message の fetch/edit と活動通知は別の失敗境界にする。既存 message を作り直すのは
  Discord が `Unknown Message` を返した場合だけで、活動通知や一時的な fetch/edit 障害から
  status message を重複作成しない。

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

**CC-COST-LIMIT-HISTORY-90D:** Memoria の残量グラフの3ヶ月表示（90日）を支えるため、
`cost_limit_samples` は直近90日を保持する。保持・削除の所有者はCcの既存limit samplerであり、
他サービスに履歴の複製を持たせない。観測済みの値だけを返し、すでに削除された履歴は補わない。
トークン利用量の `cost_usage_samples` は従来どおり60日保持とする。

sample 保存時は、provider が観測した利用率だけを記録し、欠けた枠を過去の sample から
補完しない。利用率を 1 つも観測できなかった provider は記録しない。一時的な取得失敗には、
各 provider の取得層が直近の成功値を最長 30 分返すことで対応する。

## one-shot calls

長寿命 session 外の LLM 呼び出しは `/v1/cost/one-shots` で記録・参照する。

- `POST`: `service`、`provider`、`prompt` 必須。status は `ok/error/timeout`、それ以外は
  `unknown`。input/output/total tokens、USD cost、command/model/cwd、metadata を保存する。
- `GET`: `limit` 既定 100 と `since`（epoch milliseconds、既定 24 時間前）を受け、recent
  calls と service/provider 別 summary を返す。recent calls は prompt 本文を含めず、
  `promptChars` に本文の Unicode code point 数を返す。

prompt はコスト記録のため永続化するが、一覧応答には含めない。secret や個人データを prompt へ
含めない。

## 日次 budget

`GET /v1/admin/cost-budget` は設定値、当日 tokens、blocked、date を返す。
`PUT /v1/admin/cost-budget` は有限 number の `daily_token_budget` を設定し、`0` は無効化。
admin path は app の admin auth middleware 配下にある。

budget 超過時の dispatch 停止は runtime の `costStatus.blocked` を各 chat/delegation 経路が参照して
実施する。本 API は状態の設定・表示面であり、個々の kill-switch 判定を再実装しない。

### 個人の AI 予算との関係

全体と子会社の日次 budget は本機能 (observability) が所有する。個人の月間分と報酬分は
[個人の AI 予算](./personal-ai-budget.md) が所有し、本機能の table を書かない。

- 子会社の受付 (`src/subsidiary/gate.ts`) は、子会社の日次 budget の超過と依頼者を個人の予算の port へ渡し、
  「通してよいか・どこから引くか」を受け取る。個人の予算が効いていない依頼者 (月間分の上限が 0 かつ報酬分が 0、
  本社、依頼者なし) は、全体が超過していない限り従来どおり子会社の日次 budget だけで決まる。
- 子会社が超過中でも、報酬分が残っている個人は通す。その間の消費は報酬分から引く。
- 全体の日次 budget (`costStatus.blocked`) は port へ「超過中か」だけを渡す。全体が超過中なら、個人の予算が
  効いているかに関わらず全員を通さない (停止スイッチ、CC-PBUDGET-INV-03)。
- 個人の消費の計上は、本機能と同じ provider ログの累積 (`readSessionUsage`) を読み、baseline は
  個人の予算の側 (`personal_budget_session_seen`) が持つ。

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
