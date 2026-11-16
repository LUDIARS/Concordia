---
task: followup-activity-fingerprint
project: Concordia
kind: 実装
status: review
created: 2026-11-16T00:00:00.000Z
source_session: lictor-9f9a75a2-0f48-4d7c-bd36-f2aefbcb94f8
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---
# 自動確認の「前回から変わったか」を、追跡状態ではなく観測された動きで判定し、管制と同じ基準にする

neco 指示 (2026-11-16)「自動確認の更新判定も同じようにやって」。親セッションからの追加依頼。

### 価値 / 不変条件

- 自動確認の変化あり / なしを、追跡状態の指紋 (state・タスク。ほぼ unknown で空) ではなく、観測された実際の動きで決める: 前回の自動確認以降の人間の入力 (自動確認が末尾に見えないほど会話が進んでいれば最終活動時刻)、HEAD と作業ツリーの変化、PR・委託の状態変化、サイドチャンネル現況の更新。
- 自動確認への返答だけ (`[変化なし]`・tool_result だけの読み直し) は動きに数えない。unknown だからと毎回「変化あり」にしない / 動いているのに「変化なし」にしない。
- 比較 (`classifyActivity`) と停止判定 (`isActivityStalled`、2 回以上変化なし) は自動確認と管制で同じ純関数を使う (二重実装しない)。
- 変化なしの回は Discord へ報告しない既存方針を維持し、確認 (inject) と記録は続ける。見送りは info ログに残す。

### 変更

- `src/control/session-activity.ts` (新設・純関数): 観測の指紋 `activityFingerprint`、会話の動きの印 `conversationActivityMark`、前回との比較 `classifyActivity`、停止判定 `isActivityStalled` / `ACTIVITY_STALL_UNCHANGED_MIN`。
- `src/control/session-activity-observe.ts` (新設): 作業ツリーの HEAD と `status --porcelain` を読む `observeGitActivity` (読めなければ null)。
- `src/control/followup-progress.ts`: `followupProgressFingerprint` (追跡状態) を廃止し `followupActivityFingerprint` に置換。記録に表示用の `state` を追加 (指紋には入れない)。比較は `classifyActivity` へ委譲。
- `src/control/stalled-session-nudge.ts`: 送信ごとに活動の指紋を記録。オプション `observeGit` / `sideReportedAt` を追加。変化なしの回は info ログ `stall nudge report skipped: no observed activity since previous check`。
- `src/bootstrap/core.ts`: `observeGit` (defaultGitRunner) と `sideReportedAt` (`stats.latest`) を配線。
- `src/control-session/stall-digest.ts` / `hourly-summary.ts`: 停止判定を `isActivityStalled` に統一。`board-projection.ts`: state は記録の `state` を優先し、旧形式の記録だけ指紋から読む。
- `spec/feature/autonomous-work-continuation.md` §2「変化なしは報告しない」、`spec/feature/control-session.md` §4 を更新。`cc.acceptance.json` と `spec/domains/autonomous-continuation.domain.json` に新設ファイルを追加。

### 受入

- 全員無活動 (自動確認への返答だけ・unknown) のデータで `unchanged_count` が増え、止まっている扱い (`isActivityStalled`) になり、Discord 通知 (`session.stall_nudged`) は初回だけ。
- コミット・人間の入力・PR の状態変化・現況報告があれば変化ありとして 0 に戻る。
- tool_result だけの返答は動きに数えない。

### 対象境界

- 自動確認の送信条件 (idle・cooldown・人間待ち・3 アウトの適用範囲) は変えない。変えるのは「変化あり / なし」の判定と記録だけ。
- 追跡状態 (タスク・関連付け失敗・取得不能の取得元) の変化だけでは変化ありにしない (挙動変更。テストを更新済み)。

### 復旧方法

- metadata `cc_followup_progress` を消せば次の自動確認は「変化あり」として通知される。旧形式の記録は指紋が一致しないので、切替後の最初の 1 回は変化ありになる。
