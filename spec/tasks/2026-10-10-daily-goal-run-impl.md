---
task: daily-goal-run-impl
project: Concordia
kind: 実装
created: 2026-10-10T00:00:00.000Z
memory_links: []
---
# デイリーゴール自走 (daily-goal-run) の実装

仕様の正本: `spec/feature/daily-goal-run.md` (WM-2)、`spec/feature/work-modes.md`。
domain 宣言: `spec/domains/daily-goal-run.domain.json`、`spec/domains/work-modes.domain.json`。
価値 UX-CC-W9 / シナリオ UX-CC-S10、不変条件 CC-DG-INV-01〜08・CC-WM-INV-01〜04。
neco 指示 (2026-10-10): 「実装開始」。仕様の「実装の分割」5 単位を **1 PR にまとめて** フルセットで実装する
(MVP・スタブ・TODO で残さない)。

## 決めてあること (設計判断。変えるときは理由を PR に書く)

### 1. ドメイン `src/daily-goal-run/`

業務判断は純関数、手順は use case、外部 I/O は adapter (port) に分ける。transport SDK・DB・env に
ドメイン層から直接依存しない。1 ファイル 1 責務。

- `domain.ts`: 型。`DailyGoal { id, date (YYYY-MM-DD, ローカル), project, repoPath, goalText, acceptance: string[],
  actioTaskIds: string[], permissions: { merge, test, service, deploy: boolean }, confirmedBy: { platform: "discord",
  userId, guildId, channelId, messageId? }, confirmedAt, status, sessionId?, runId?, launchState, stopReason?, createdAt }`。
  `status`: `confirmed | running | achieved | exhausted | stopped | lost`。
  `launchState`: `none | intent | launched | unknown` (起動の結果不明を表す)。
- `confirmation-policy.ts`: `validateDraft(draft)` → 欠けている項目の一覧 (project / goalText / acceptance 1 件以上 /
  actioTaskIds 1 件以上 / permissions の 4 項目が明示)。欠けがあれば確定しない。
  確定者の本人性: bot・webhook・system は拒否。許可範囲はその人の staff 権限を超えられない
  (`merge`・`deploy` を可にするには `merge_pr` capability = manager 以上、確定自体は `session_spawn` = staff 以上。
  `src/staff/roles.ts` の `capabilityAllowed` を使う)。
- `launch-policy.ts`: `launchAt(confirmedAt, date, launchTime = "07:30")` → 当日 7:30 より前の確定は 7:30、
  以降は確定時刻。`isDue(goal, now)`。起動時刻は設定 `daily_goal.launch_time` (既定 07:30) から都度解決。
- `checkpoint-policy.ts`: 前回の確認以降の証跡 (commit / PR 状態変化 / Actio task 状態変化) の差分から
  `progress | no_progress` を判定。進捗ありなら「進捗確認」、進捗なしなら「完了確認」の inject 文面種別を返す。
  未回答の質問 / human-wait 中なら `skip_waiting` (送らない・予算を戻さない)。
- `stop-policy.ts`: 止まる条件は 3 つだけ。
  - `evaluateGoalReached(acceptance, evidenceByItem)`: 受入条件の全項目に Cc の証跡が対応していれば到達。
    セッションの自己申告だけでは到達にしない。
  - `evaluateExhausted(remaining)`: `remaining: Array<{ item, class: "unachievable", reason } | { item, class: "human_judgment",
    questionId?, humanWaitId? } | { item, class: "doable" }>`。1 件でも `doable` があれば拒否し続行。
    `unachievable` は reason 必須、`human_judgment` は未回答の質問か active な human-wait に実在すること (照合は use case 側で port 経由)。
  - 人間の停止は本人の操作のみ。
  - 時刻・日付・停滞では止めない。
- `repository.ts`: Cc 所有の永続化。`sprint-dialogues/repository.ts` と同じく constructor で
  `CREATE TABLE IF NOT EXISTS daily_goals` / `daily_goal_checkpoints` / `daily_goal_cards`。
  checkpoint は `{ id, goal_id, at, kind (progress|completion|skipped_waiting), evidence JSON, progress boolean, report?, decision }`。
  起動は intent を先に保存してから invoke する (CC-INV-03)。
- `evidence.ts` (port + adapter): `EvidencePort.collect(goal, since)` → commits (セッションの repo_path/branch の
  `git log --since` を既存の git 実行ヘルパ経由・タイムアウト付き)、PR (Cc の pr_records / Revisor local PR の状態)、
  Actio task 状態 (`src/taskflow` の TaskStore / Actio client 経由の読み取りのみ。Actio へ書かない)。
- `service.ts` (use case): `confirmGoal`、`launchDue(now)`、`runCheckpoint(goalId, now)`、`reportExhausted(goalId, sessionId, remaining)`、
  `reportReached(goalId, sessionId)` (照合して到達を判定)、`stopByHuman(goalId, actor)`、`onSessionLost(sessionId)`。
- `scheduler.ts`: `startSupervisedInterval` (`src/shared/loop-bulkhead.ts`) で 1 分ごとに tick。
  期限が来た confirmed ゴールを起動、running ゴールは起動から 60 分ごとに確認。設定 `daily_goal.checkpoint_minutes` (既定 60)。
  候補カードは起動時刻の 30 分前 (既定 07:00) に 1 回。日付が変わっても running は止めない。

### 2. 起動

- delegation テンプレート `daily-goal-runner` を `src/delegation/seed.ts` に追加 (role `employee`、Opus 5.5 / medium)。
  依頼文はゴール文・受入条件・許可範囲・Actio task ID だけ + 手順: ゴールの範囲だけで作業 / セッション外 task を持ち込まない /
  許可範囲外は ask で止まる / 確認 inject への返答形式 / 到達・やり切りの報告 API。
- invoke は `options: { goal_and_go: true }`、`cwd: goal.repoPath`、`project`、`triggered_by: "daily-goal-run"`。
  起動後にセッション metadata へ明示 `goal` (`src/control/goal.ts` の形) と `work_mode: "daily-goal-run"` を書く。
- 結果不明 (例外・タイムアウト) は `launchState = unknown` にし、delegation run 一覧 (`triggered_by` + daily_goal_id) と照合。
  見つかるまで再 invoke しない。
- 喪失したセッションは `lost` にし、自動で別セッションを起動しない。

### 3. 確認と Goal & Go 連携

- `src/control/goal-and-go.ts` に `resetGoalAndGoBudget(repo, sessionId)` を export で追加
  (`instructed: true` を保ち、count / started_at / last_continued_at / stopped_reason を初期化)。
  daily-goal-run の確認が「進捗あり」または「完了確認で doable が残る」ときだけ呼ぶ。回答待ち・停止後は呼ばない。
  goal-and-go 側の既存挙動 (人間入力でのリセット) は変えない。
- 確認の inject は既存の `session.inject` 経路 (source `auto:daily-goal-run`) を使い、送る直前に
  `allowAutoInject` (`pending-question-blocker.ts`) と `isHumanWaitActive` を確認する。

### 4. 表示と入口

- Discord `/co-daily-goal` (`src/discord/commands/daily-goal.ts`): project / goal / acceptance (改行区切り) / actio_tasks /
  merge / test / service / deploy (bool) を受け、interaction の user で確定する。欠けは ephemeral で聞き返す。
- 停止は Discord のカード上のボタン (本人確認 + `session_control` = manager 以上、または確定者本人)。
- カード: ゴールごとに 1 message を作り、以後は同じ message を編集。カードには 証跡 / セッションの報告 / 人間判断 を分けて載せ、
  タイムラインに 1 行ずつ足す。状態表示は 達成 / やり切り (残りと決めてほしい点) / 停止 / 喪失 / 回答待ち / 継続中。
  投稿の intent を先に保存し、結果不明で同じ投稿を再送しない (sprint-dialogues の CC-SD-04 と同じ扱い)。
- 候補カード: 設定 `daily_goal.candidate_projects` (既定 空 = 候補カードを出さない) のプロジェクトだけ。材料は Actio の進行中・
  期限の近い task と前日の「やり切り」の残り。候補は案であり、確定ボタンは /co-daily-goal と同じ確定経路へ渡す。
- HTTP `src/api/daily-goal-run.ts`: `GET /v1/daily-goals?date=`、`GET /v1/daily-goals/:id` (checkpoints 込み)、
  `POST /v1/daily-goals/:id/reached` と `POST /v1/daily-goals/:id/exhausted` (呼べるのは紐付いた session_id のセッションだけ)。
  確定と停止の HTTP は Discord 経路の内部呼び出しに限り、人間の判断を作れる公開 HTTP は設けない。loopback 限定・body 上限は既存 API に合わせる。
- workflow toggle に `daily_goal` を追加 (`src/workflow/keys.ts`、既定 有効)。無効時はスケジューラ・コマンド登録・API を止める (API は 409 + 理由)。

### 5. 方式の記録 `src/work-modes/`

- `work-mode.ts`: `readWorkMode(metadata)` / `withWorkMode(metadata, mode)`。別の方式が active のセッションへ別方式を書こうとしたら拒否 (CC-WM-INV-01)。

## テストと受入

- 各純関数と repository・service (fake port) の vitest を同じ変更で書く。wiring test を `tests/daily-goal-run-wiring.test.ts` に。
- `cc.acceptance.json` の implementations に source / tests を対応付ける。
- 仕様 `daily-goal-run.md` の受け入れ基準を 1 項目ずつテストへ対応させ、PR 本文に対応表を書く。
- 実行してよいのは typecheck と build だけ。単体・統合・起動テストの実行と Cc の再起動はしない (登録テストは Revisor に任せる)。

## 自己検証 (PR 本文に結果を書く)

- `grep -rn "TODO\|FIXME\|not implemented" src/daily-goal-run src/work-modes` が 0 件。
- `src/daily-goal-run/*-policy.ts` が `better-sqlite3` / `discord.js` / `process.env` を import していない。
- `resetGoalAndGoBudget` の呼び出し元が daily-goal-run の確認だけ。
- 止まる条件の判定に時刻・停滞による停止が無い。

## 完了条件

- [x] 上記 5 単位がすべて実装・配線され、tests が同じ PR にある。
- [x] typecheck と build が通る。
- [ ] Revisor local PR を提出し、審査の指摘に対応してマージまで進む。

## 実装結果 (2026-10-10)

### 自己検証の結果

- `grep -rn "TODO\|FIXME\|not implemented" src/daily-goal-run src/work-modes`: 0 件。
- `src/daily-goal-run/*-policy.ts` の `better-sqlite3` / `discord.js` / `process.env` import: 0 件。
- `resetGoalAndGoBudget` の呼び出し元: `src/bootstrap/daily-goal-run.ts` の autonomy port だけ。port を呼ぶのは
  `checkpoint.ts` (進捗ありの確認) と `finish.ts` (完了確認に対する doable 返答、回答待ちでないとき) の 2 箇所。
- 止まる条件: `daily_goals.status` を終了させるのは `finish.ts` の到達・やり切り・人間の停止と、喪失の記録だけ。
  `stop-policy.ts` は時刻を入力に取らず、scheduler は日付が変わっても running を止めない。
- 実施した検証: `tsc --noEmit -p tsconfig.json` (通過)、`npm run build` (通過)、Anatomia `pr-review` (5 ゲート通過)、
  `augur tests lint` (valid)。単体・統合・起動テストは指示により未実行 (Revisor の登録テストに任せる)。

### 設計判断を変えた点

- 到達の報告は `reportReached(goalId, sessionId, claims)` とし、受入条件ごとの証跡の参照をセッションが挙げ、
  Cc が集めた証跡に実在するものだけで照合する (受入条件と証跡の対応を機械的に推測できないため)。
- セッションの報告文を受ける `POST /v1/daily-goals/:id/report` を追加した。カードの「セッションの報告」に
  載せるだけで、進捗・到達の判定には使わない。
- カードは確定したチャンネルのスレッドではなく、meta カテゴリの「デイリーゴール」チャンネルに 1 ゴール 1 message で置く
  (候補カードと同じ置き場にし、確定チャンネルが流れても追えるようにするため)。
- 起動の依頼の同一性は `triggered_by` の検索ではなく、起動前に保存した run id を `reserved_run_id` として渡して持つ。
  照合は `delegation_runs` の id で行う。Actio に新しい task を封印しないよう `task_binding: "caller"` で起動する。

