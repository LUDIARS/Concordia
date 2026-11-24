---
type: plan
title: "パートタイマー軽作業を dots / Muse の指令へ移す — 定時ジョブの宛先切替と結果の引き取り"
service: concordia
domain: parttimer-review-scheduling
status: draft
related:
  - plan/2026-11-24-control-session-to-dots.md
  - feature/agent-instructions-bridge.md
  - feature/delegation-parttimer-inject.md
updated: 2026-11-24
---

# パートタイマー軽作業を dots / Muse へ移す

Actio `5075ba3e-56f7-4f53-a732-af3fda910879` (受入条件 (3) 軽作業の割当て)。Cc v5 (PR #4127、merge `f642aed9e`) の続き。

## 経緯

- 2026-11-23 neco 指示 (原文):「パートタイマー軽作業の多くをMuseとdotsに割り当てることにした。dotsと相談しながら移行を進める」
- 2026-11-24 dots 回答 (inst:dots:20261123T130231Z:cff4ae、`plan/2026-11-24-control-session-to-dots.md` 付録 A): 軽作業のうち朝礼・Memoria 関連未完了・ディレクター整理・課題スカウト・依存点検・週次レビュー・AIノートの下書き・ダッシュボードは dots が要約・判断・提案し、通知・書き込み・変更は既存側 (Cc) に残す。Genius・Vultus・Steam persona・Gmail watch・メール取り込みは Cc / 本社に残す。dots は現状手動受領 (5 分間隔の自動ポーリングは未設定)。
- 2026-11-24 neco 指示 (原文):「パートタイマーの処理を移動していって」

## 価値と状態の所有者

- 価値: 定時の軽作業でローカルの Claude / Codex セッションを起こさず、外部エージェントに判断・要約を任せて本社 PC の負荷とコストを下げる (UX-CC-W3 / W4)。止まっても作業が消えない。
- 定時ジョブの定義・発火: Cc の cron scheduler (`src/scheduler/cron-jobs.ts` / `cron-scheduler.ts`、チームごとの fanout を含む)。
- 指令と結果: 指令ブリッジ `agent_instructions` (CC-INST-*)。
- 書き込み・通知 (Discord 投稿・Memoria / Actio への記録・PR): 従来どおり Cc 側。外部エージェントは result を返すだけ。

## 方式

### 1. ジョブごとの宛先切替

- 既存の「ジョブごとのテンプレート差し替え」(`adminState.getCronJobOverride(jobName)`) と並べて、ジョブごとの宛先 `scheduler.cron_job_agent.<jobName>` (`""` = 従来の委託 / `dots` / `muse`) を設定に持つ。既定は全ジョブ `""` (挙動は変わらない)。WebUI の設定画面でジョブごとに切り替えられる。
- 宛先が外部エージェントのとき、発火時 (fanout なら対象ごと) に委託 invoke の代わりに指令を 1 件登録する: `type=run_task`、`title=<テンプレートの title>[ — <チーム名>]`、`body` = テンプレートのパートタイマー本文 (`parttimer-prompts.ts` の本文。Cc の API を叩く手順・ファイル操作・投稿の手順は除き、「判断・要約して result で返す」形に書き換えた **外部エージェント用の本文**)。`params = { job, target?, fired_at, dedupe_key, data }`。
- `dedupe_key = cron:<jobName>:<target id or "-">:<発火時刻 (分単位、JST)>`。同じキーの指令は 2 度登録しない (Cc 再起動直後の再発火・二重 tick を防ぐ)。

### 2. 渡すデータ (data builder)

- 外部エージェントは Cc・Memoria・Actio のローカル API に届かない。判断に要る **最小の読み取りデータ** を Cc が集めて `params.data` に入れる。ジョブごとに data builder を 1 つ持つ (純関数 + 読み取り adapter)。
- 上限は指令の params 8000 バイト (CC-INST-INV-01)。収まらないときは古い / 優先度の低いものから落とし、`data.truncated = n` を付ける。
- 入れないもの: 秘密・鍵・トークン、個人の連絡先、メール本文・添付、未公開リポのコード本文。個人範囲の制御が無い Memoria / Actio の入口から読んだデータは入れない (dots 回答)。
- data builder が無いジョブは宛先を外部エージェントにできない (設定の保存時に 400)。

### 3. 結果の引き取り (result applier)

- 指令の `finished` (指令ブリッジの出来事、v5 で追加した `subscribe`) を受け、`params.job` のジョブの result applier が結果を従来の出力先へ反映する (例: 朝礼はチームのチャンネルへ投稿、ダッシュボード日報は要約の投稿)。反映は Cc が行い、外部エージェントの文面は信頼できない入力として扱う (mention 無効化、リンク展開なし、長さ上限)。
- PR を作る・Memoria / Actio へ書くジョブは、外部エージェントの「提案」を人間か Cc のセッションが採るまで書かない (今回の範囲では提案の投稿まで)。
- `failed` の結果は従来の出力先へ「<エージェント> が失敗: 要約」と出す。

### 4. 受け取られないときの戻し (fallback)

- 指令が `acked` にならないまま `scheduler.cron_job_agent_fallback_minutes` (既定 180 分) を過ぎたら、Cc がその指令を `failed` (summary「期限内に受け取られなかったため Cc の委託へ戻した」) で閉じ、元の委託テンプレートを 1 回だけ invoke する。閉じた後に外部エージェントが ack / result しても既存の規則どおり 409 (二重作業にならない)。
- 戻した事実は従来の出力先と、管制のまとめ (dots 連携) に出す。
- dots が 5 分間隔の自動ポーリングを始めるまでは、この戻しが毎日の作業を守る。

## 割当て (最初の切替候補)

dots 回答の Q3 を元にした。切替そのもの (設定値) は v5 の反映後に人間の確認を取って行う。

| ジョブ | 宛先 | data | 結果の反映 |
|---|---|---|---|
| チーム朝礼 (fanout) | dots | チームの Actio タスク (題・状態・担当・期限、最大 30 件)、前日のチームのセッション要約 | チームのチャンネルへ投稿 |
| 関連未完了タスク取得 (Memoria) | dots | — (個人範囲制御が無いので今回は外す) | — |
| ディレクター タスク整理 (fanout) | dots | 同上のタスク一覧 + Director 案件の題・状態 | 提案として投稿 (書き込みなし) |
| ディレクター 課題スカウト (fanout) | dots | チームのプロジェクトの直近の PR 題・CI 失敗・Revisor 所見の要約 | 提案として投稿 |
| 日次依存関係点検 (`deps-sweep-daily`) | dots | 公開リポのマニフェストの所在 (GitHub URL) と前回の点検結果の要約 | 報告として投稿 (PR は作らない) |
| 週次レビュー (`ludiars-review-weekly`) | dots | 対象リポの正確な ref と差分の統計・ファイル一覧 | 提案として投稿 |
| AIノート記事 隔週レビュー (`ai-note-biweekly-review`) | dots | 選定済み記事の題・公開 URL・前回所見 | 下書きとして投稿 |
| LUDIARS ダッシュボード日報 (`ludiars-status-daily`) | dots | サービスの稼働状態・版の一覧 (service-status / service-versions) | 要約の投稿。日報の PR は Cc 側の委託が引き続き作る |
| 脆弱性対応・カイゼン・Genius・Vultus・Steam・Quaestor 系 | 従来どおり | — | — |

Muse の割当ては未決 (neco 判断待ち)。仕組みは宛先を選ぶだけなので、決まり次第設定で切り替えられる。

## 不変条件

| ID | 内容 |
|---|---|
| CC-PT-AGENT-INV-01 | 宛先未設定 (既定) のジョブは従来どおり委託を invoke する (挙動を変えない) |
| CC-PT-AGENT-INV-02 | 1 回の発火 (対象ごと) につき指令は 1 件。同じ dedupe_key は再登録しない |
| CC-PT-AGENT-INV-03 | params に秘密・個人情報・メール本文・未公開コード本文を入れない。8000 バイトに収める |
| CC-PT-AGENT-INV-04 | 外部エージェントは書き込み・通知をしない。反映は Cc の result applier だけが行い、文面は信頼できない入力として扱う |
| CC-PT-AGENT-INV-05 | 期限内に受け取られない指令は Cc が閉じて元の委託を 1 回だけ起動する。閉じた指令への後からの ack / result は反映しない |
| CC-PT-AGENT-INV-06 | data builder の無いジョブは外部エージェントへ切り替えられない |

## 実装の置き場所 (DDD)

| 層 | ファイル |
|---|---|
| ドメイン (純関数) | `src/scheduler/agent-dispatch-policy.ts` (宛先の決定・dedupe_key・fallback の要否)、`src/scheduler/agent-jobs/<job>.ts` (ジョブごとの外部エージェント用本文・data の組み立て・結果の整形) |
| use case | `src/scheduler/agent-dispatch.ts` (発火 → 指令登録 / 委託 invoke の分岐)、`src/scheduler/agent-result-intake.ts` (finished → applier)、`src/scheduler/agent-fallback.ts` (期限切れ → 閉じて委託) |
| adapter | data builder の読み取り (Actio taskflow 一覧・Director・service-status・Revisor 一覧は既存の client を使う)、出力先 (既存の Discord 投稿口) |
| 設定 | `scheduler.cron_job_agent.<jobName>` (ジョブごと)、`scheduler.cron_job_agent_fallback_minutes` |
| Web | 設定画面の定時ジョブ欄に宛先の選択 (data builder の無いジョブは選べない) |
| spec | `spec/feature/parttimer-agent-dispatch.md` (新設)、`parttimer-review-scheduling` ドメインの specRefs 追加、`agent-instructions-bridge.md` に cron 由来の指令と Cc による期限切れ終了を追記 |

テスト: 宛先未設定で従来どおり invoke、宛先 dots で指令が 1 件 (fanout は対象ごと)、dedupe、params の上限と除外、result applier の反映と mention 無効化、fallback (期限切れで閉じて 1 回だけ invoke、閉じた後の result は無視)、data builder の無いジョブの切替拒否。

## 復旧

ジョブの宛先を `""` に戻せば次の発火から従来の委託に戻る。登録済みの指令は fallback で閉じるか、外部エージェントの結果で閉じる。
