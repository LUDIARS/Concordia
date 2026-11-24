---
type: feature
title: "定時ジョブの外部エージェント委託 — 宛先の切替・指令の登録・結果の引き取り・期限切れの戻し"
description: "Cc の cron scheduler が発火した定時ジョブを、ジョブごとの設定で dots / Muse の指令 (run_task) へ回す。判断に要る最小の読み取りデータを Cc が集めて params に入れ、結果は Cc が従来の出力先へ投稿する。期限内に受け取られない指令は Cc が閉じて元の委託を 1 回だけ起動する。"
service: concordia
domain: parttimer-review-scheduling
status: implemented
updated: 2026-11-24
related:
  - plan/2026-11-24-parttimer-to-agents.md
  - feature/agent-instructions-bridge.md
  - feature/delegation.md
tags:
  - parttimer
  - dots
  - muse
  - cron
---

# 定時ジョブの外部エージェント委託

> 所属ドメイン: [`parttimer-review-scheduling`](../domains/parttimer-review-scheduling.domain.json)
> 設計: [`plan/2026-11-24-parttimer-to-agents.md`](../plan/2026-11-24-parttimer-to-agents.md) / Actio `5075ba3e-56f7-4f53-a732-af3fda910879`

2026-11-23 neco 指示「パートタイマー軽作業の多くをMuseとdotsに割り当てることにした。dotsと相談しながら移行を進める」、
2026-11-24 neco 指示「パートタイマーの処理を移動していって」。

## 価値と状態の所有者

- 価値: 定時の軽作業でローカルの Claude / Codex セッションを起こさず、外部エージェントに判断・要約を任せる。止まっても作業が消えない (戻しがある)。
- 定時ジョブの定義・発火: Cc の cron scheduler (`src/scheduler/cron-jobs.ts` / `cron-scheduler.ts`)。
- 指令と結果: 指令ブリッジ `agent_instructions` ([agent-instructions-bridge.md](agent-instructions-bridge.md))。
- 書き込み・通知: Cc。外部エージェントは result を返すだけ。

## 設定

| キー | 値 | 既定 |
|---|---|---|
| `scheduler.cron_job_agent.<jobName>` | `""` (従来の委託) / `dots` / `muse` | 未設定 = `""` |
| `scheduler.cron_job_agent_fallback_minutes` | 1〜10080 の整数 (分) | 180 |

- 発火ごとに読むので、切替に再起動は要らない。許可リスト外の保存値は従来の委託として扱う。
- 管理 API (`src/api/cron-job-agent-routes.ts`、loopback): `PUT /v1/admin/cron-jobs/:name/agent` `{agent}`、`GET|PUT /v1/admin/cron-jobs-agent-fallback` `{minutes}`。`GET /v1/admin/cron-jobs` の各行に `agent` と `agent_supported` を足す。
- WebUI: 設定画面の「定期実行 (Cron)」欄 (`web/src/pages/settings/sections/CronJobsSection.tsx`) にジョブごとの宛先と戻しの分。data builder の無いジョブは外部エージェントを選べない。

## 対応ジョブ (`src/scheduler/agent-jobs/`)

| ジョブ | 本文・data (`agent-jobs/<job>.ts`) | 読み取り (`agent-job-sources/`) | 結果の種別 |
|---|---|---|---|
| `ludiars-status-daily` | サービスの code・名前・状態・本社の観測か (止まっている順)、前回の要約 | `service-status-items.ts` (Excubitor の観測。拠点名は渡さない) | 要約 |
| `ludiars-review-weekly` | Tier 1 リポの main の HEAD・前回レビューの HEAD・commit 数・差分の統計とファイル一覧 (1 リポ 30 件) | `review-targets.ts` / `service-map.ts` / `git-read.ts` (コード本文は読まない) | 提案 |
| `ai-note-biweekly-review` | evergreen を除き最終レビューが 14 日以上前の記事の題・区分・日付・所見・URL、前回の要約 | `ai-note-articles.ts` (記事本文は読まない) | 下書き |
| `deps-sweep-daily` | 設定の GitHub org にあるリポのマニフェストの URL、前回の要約 | `dependency-repos.ts` (マニフェストの中身は読まない。org 未設定は失敗) | 報告 |
| `quaestor-mail-sweep` | 実行枠・日付、取り込みの結果、分類別件数、要確認件数と文書 ID、通知件数、エラー種別とメッセージ ID | 本社 Cc が発火時に Quaestor へ sweep を一度依頼し、文書一覧からは ID だけを取り出す | 管制へ報告 |
| `kaizen-daily` | 前日 JST の失敗・停滞の集計 | Cc DB の集計専用の読み取り | dots の提案を Cc がクラウド実装または管制カードに回し、結果を管制へ投稿 |

### メール監視とカイゼン

Actio `actio:cc99b26e-366a-430c-bf58-0f72aa95fc9d`。対象の価値は UX-CC-W4/W5、シナリオは UX-CC-S5/S6。
Quaestor がメール・文書の状態を所有し、Cc は発火キーごとの実行予約と最小限の結果を保存する。
予約が成功した場合だけ sweep を送信する。同じ発火で応答を失った場合は再送せず、期限後の再処理では結果不明と報告する。
停止後の同じ発火の再処理には保存済みの結果を使う。指令登録前の中断は cron 自体の過去分再生の対象外。
取り込み失敗・結果不明・無効化も指令の材料に含める。要確認文書一覧は既存の要確認分を含み、今回の件数とは別に扱う。

カイゼンのカウントは前日 JST の 00:00 から当日 00:00 までを対象にし、人間待ちはその区間の終端時点を集計する。
30 分で pending に戻った指令は日ごとの件数を遷移と同時に記録する。計測開始前を含む日は件数を不明 (`null`) とする。
本文、transcript、個人情報を渡さない。
この 2 本は外部宛先で失敗・受取期限切れになった場合、従来の委託は起動せず管制に報告する。
宛先を空にすると次の発火から従来の委託が実行される。

2026-11-24 neco 指示により、Cc 本社が登録した dots 宛てカイゼン指令の成功回答を自動で仕分ける。
`detail.items` は投稿用に残し、`detail.proposals` に `{title, reason, target_repo, kind, instruction?}` を返す。
`target_repo` は登録済みプロジェクトコード、`kind` は `cloud_fix` または `human_judgment`。
題は 120、理由は 500、実装指示は 3000 UTF-16 コード単位までとする。実装候補には指示が必須。
Cc は適格な候補を上限内で順に Actio に登録し、既存の Codex Cloud Git 返送へ渡す。
`scheduler.kaizen_cloud_max_per_run` は既存の管理設定 API から変更できる。既定値は 3、範囲は 1〜10。回答は最大 20 件とする。
人間判断、上限超過、対象外、投入失敗・受付不明は管制カードにし、結果を既存の管制チャンネルへまとめて投稿する。
不正入力は処理せず件数を報告する。Cloud の成果は既存の Git 受領・Revisor 提出を通す。
宛先が dots 以外の場合は従来の結果処理を使う。

- 一覧の正本は `agent-jobs/registry.ts` の `AGENT_JOB_NAMES`。ここに無いジョブは宛先を外部エージェントにできない。
- 外部エージェント用の本文は `agent-jobs/body.ts` の共通の枠 (材料は params.data だけ・summary と detail.items で返す・書き込みや PR をしない) に、ジョブ固有の依頼を載せる。
- 今回入れていないもの: チーム朝礼 / ディレクター タスク整理 / 課題スカウト (2026-09-01 の指示で cron から外れていて発火元が無い。fanout の分岐は対象ごとに 1 件で実装済み)、Memoria 関連未完了 (個人範囲の制御が無い)、日報の版の一覧 (Revisor の版照会は対象指定式のため)。

## 流れ

1. **発火の分岐** (`src/scheduler/agent-dispatch.ts`、cron scheduler の `dispatchToAgent`): 宛先が未設定なら `not_routed` を返し、cron scheduler が従来どおり委託を invoke する。宛先があれば data builder で data を作り、`agentInstructions.registerOnce` で `type=run_task` の指令を 1 件 (fanout は対象ごと) 登録する。
   - `title` = テンプレートの title (+ ` — <チーム名>`)、`body` = 外部エージェント用の本文。
   - `params = { job, target?, fired_at, dedupe_key, call_name, args, options?, data }`。`call_name` / `args` / `options` は戻しで同じ委託を起動するために持つ。
   - `dedupe_key = cron:<jobName>:<target or "-">:<発火時刻 (JST の分)>`。同じキーの指令は登録しない。
   - data builder が失敗した・data が上限に収まらない・宛先にジョブ定義が無いときは warn を残して従来の委託を invoke する。外部宛先のメール監視とカイゼンでは、戻し専用の `call_name` / `args` / `options` を指令に含めず、登録に失敗した場合は warn を残す。
2. **結果の引き取り** (`src/scheduler/agent-result-intake.ts`): 指令ブリッジの出来事を `subscribe` で受け、cron 由来 (dedupe_key が `cron:`) の `finished` を、ジョブの種別の文面 (`agent-jobs/result-post.ts`) で管制チャンネルへ投稿する。`failed` は「<エージェント> が失敗: 要約」。Cc が期限切れで閉じた `finished` (detail `closed_by: concordia`) は投稿しない (戻しが自分で投稿する)。
3. **期限切れの戻し** (`src/scheduler/agent-fallback.ts`、5 分周期): cron 由来で `pending` のまま期限を過ぎた指令を `closeUnreceived` で `failed` (summary「期限内に受け取られなかったため Cc の委託へ戻した」、detail `{closed_by:"concordia", fallback:"delegation"}`) にし、閉じられたときだけ元の委託を 1 回 invoke して、その事実を管制チャンネルへ投稿する。
- 結線は `src/scheduler/agent-dispatch-runtime.ts`。結果の引き取りと戻しは cron scheduler の workflow binding (`daily`) と同じ寿命で動く。

## 不変条件

| ID | 内容 | 実装 |
|---|---|---|
| CC-PT-AGENT-INV-01 | 宛先未設定 (既定) のジョブは従来どおり委託を invoke する (挙動を変えない) | `agent-dispatch.ts` / `cron-scheduler.ts` |
| CC-PT-AGENT-INV-02 | 1 回の発火 (対象ごと) につき指令は 1 件。同じ dedupe_key は再登録しない | `agent-dispatch-policy.ts` `buildDedupeKey` / `instruction-service.ts` `registerOnce` |
| CC-PT-AGENT-INV-03 | params に秘密・個人情報・メール本文・未公開コード本文を入れない。8000 バイトに収める (配列の末尾から落とし `data.truncated` に件数) | 各 data builder (項目の許可リスト) / `agent-dispatch-policy.ts` `scrubValue` `fitParams` |
| CC-PT-AGENT-INV-04 | 外部エージェントは書き込み・通知をしない。反映は Cc の result applier だけが行い、文面は信頼できない入力として mention とリンク展開を無効化し 1900 文字に収める (送信側も allowedMentions 空) | `agent-result-intake.ts` / `agent-jobs/result-post.ts` |
| CC-PT-AGENT-INV-05 | 期限内に受け取られない指令は Cc が閉じて元の委託を 1 回だけ起動する。メール監視とカイゼンは終了を投稿する。閉じた指令への後からの ack / result は 409 で反映しない | `agent-fallback.ts` / `instruction-service.ts` `closeUnreceived` / `agent-instructions-repo.ts` `markExpired` |
| CC-PT-AGENT-INV-06 | data builder の無いジョブは外部エージェントへ切り替えられない (API は 400、WebUI は選べない) | `src/api/cron-job-agent-routes.ts` / `agent-jobs/registry.ts` |
| CC-PT-AGENT-INV-07 | 本社 cron 登録に対応する dots の成功回答だけが起点になる。候補を登録プロジェクト・設定済み Cloud 環境・投入上限に照合し、処理中断や受付不明で同じ投入を繰り返さない | `agent-jobs/kaizen-*.ts` / `cloud-work/runtime-service.ts` |

## 復旧

- ジョブの宛先を `""` に戻せば次の発火から従来の委託に戻る。
- 登録済みの指令は外部エージェントの結果で閉じるか、期限切れの戻しで閉じる。急ぐときは戻しの分を短くする。
- 日次カイゼンの受付予約と Cloud の実行記録を保持する。回答反映の途中で止まった場合は管制カードから Actio と Cloud の受付を照合する。同じ回答による自動投入は繰り返さない。宛先の切替後も投入済み分の Git 回収は続ける。

## 検証

`src/scheduler/agent-dispatch.test.ts` (INV-01〜03) / `agent-dispatch-policy.test.ts` / `agent-result-intake.test.ts` (INV-04) / `agent-fallback.test.ts` (INV-05) / `agent-jobs/agent-jobs.test.ts` / `agent-job-sources/agent-job-sources.test.ts` / `src/api/cron-job-agent-routes.test.ts` (INV-06) / `web/src/pages/settings/sections/CronJobsSection.test.tsx`。
