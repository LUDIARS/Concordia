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

- 一覧の正本は `agent-jobs/registry.ts` の `AGENT_JOB_NAMES`。ここに無いジョブは宛先を外部エージェントにできない。
- 外部エージェント用の本文は `agent-jobs/body.ts` の共通の枠 (材料は params.data だけ・summary と detail.items で返す・書き込みや PR をしない) に、ジョブ固有の依頼を載せる。
- 今回入れていないもの: チーム朝礼 / ディレクター タスク整理 / 課題スカウト (2026-09-01 の指示で cron から外れていて発火元が無い。fanout の分岐は対象ごとに 1 件で実装済み)、Memoria 関連未完了 (個人範囲の制御が無い)、日報の版の一覧 (Revisor の版照会は対象指定式のため)。

## 流れ

1. **発火の分岐** (`src/scheduler/agent-dispatch.ts`、cron scheduler の `dispatchToAgent`): 宛先が未設定なら `not_routed` を返し、cron scheduler が従来どおり委託を invoke する。宛先があれば data builder で data を作り、`agentInstructions.registerOnce` で `type=run_task` の指令を 1 件 (fanout は対象ごと) 登録する。
   - `title` = テンプレートの title (+ ` — <チーム名>`)、`body` = 外部エージェント用の本文。
   - `params = { job, target?, fired_at, dedupe_key, call_name, args, options?, data }`。`call_name` / `args` / `options` は戻しで同じ委託を起動するために持つ。
   - `dedupe_key = cron:<jobName>:<target or "-">:<発火時刻 (JST の分)>`。同じキーの指令は登録しない。
   - data builder が失敗した・data が上限に収まらない・宛先にジョブ定義が無いときは warn を残して従来の委託を invoke する (作業を落とさない)。
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
| CC-PT-AGENT-INV-05 | 期限内に受け取られない指令は Cc が閉じて元の委託を 1 回だけ起動する。閉じた指令への後からの ack / result は 409 で反映しない | `agent-fallback.ts` / `instruction-service.ts` `closeUnreceived` / `agent-instructions-repo.ts` `markExpired` |
| CC-PT-AGENT-INV-06 | data builder の無いジョブは外部エージェントへ切り替えられない (API は 400、WebUI は選べない) | `src/api/cron-job-agent-routes.ts` / `agent-jobs/registry.ts` |

## 復旧

- ジョブの宛先を `""` に戻せば次の発火から従来の委託に戻る。
- 登録済みの指令は外部エージェントの結果で閉じるか、期限切れの戻しで閉じる。急ぐときは戻しの分を短くする。

## 検証

`src/scheduler/agent-dispatch.test.ts` (INV-01〜03) / `agent-dispatch-policy.test.ts` / `agent-result-intake.test.ts` (INV-04) / `agent-fallback.test.ts` (INV-05) / `agent-jobs/agent-jobs.test.ts` / `agent-job-sources/agent-job-sources.test.ts` / `src/api/cron-job-agent-routes.test.ts` (INV-06) / `web/src/pages/settings/sections/CronJobsSection.test.tsx`。
