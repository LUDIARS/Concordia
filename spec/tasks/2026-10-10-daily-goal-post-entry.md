---
task: daily-goal-post-entry
project: Concordia
kind: 実装
created: 2026-10-10T00:00:00.000Z
memory_links: []
---
# デイリーゴールを投稿登録・4:00 締切のまとめ・9:00 通知へ変える

仕様の正本: `spec/feature/daily-goal-run.md` (改訂版)、`spec/feature/work-modes.md`。
価値 UX-CC-W9 / シナリオ UX-CC-S10、不変条件 CC-DG-INV-01〜11。domain `daily-goal-run` (Discord adapter は `chat-platforms`)。

neco 指示 (2026-10-10):

> デイリーゴールはデイリーゴール用のチャンネルをつくり、投稿でその日の目標を登録する形でやる。
> ゴール/受け入れ条件が確認できない場合はその旨を知らせて定義してもらう。
> 次の日の朝4時を締め切りとして、4時にその日やったことをまとめる。まとめた結果はMemoriaの日記とノートに記載される。
> 目標がない場合は9:00に通知する。「目標なし」の日は許容する。
> 7:30という制限は要らなかったので撤廃する。

初版 (PR #2643、`spec/tasks/2026-10-10-daily-goal-run-impl.md`) の上に 1 PR で変更する。MVP・スタブ・TODO で残さない。

## 決めてあること

### 1. 入口: チャンネル投稿

- 既存の meta カテゴリ「デイリーゴール」チャンネル (初版でカードの置き場として作ったもの) を入口にする。
  チャンネルの topic に投稿の書き方を設定する。
- Discord adapter (`src/discord/daily-goal-post-intake.ts` など、`chat-platforms`) が messageCreate / messageUpdate を受け、
  チャンネル直下の人間の投稿だけを `daily-goal-run` の use case `intakePost` に渡す。bot・webhook・system・Cc 自身は捨てる。
  スレッド内の投稿は、そのスレッドが下書きの聞き返しスレッドで、かつ投稿者が元投稿者のときだけ `supplementDraft` に渡す。
- 「目標なし」判定は純関数 (`no-goal-policy.ts`)。前後の空白・句読点・「です」等を除いて「目標なし」と一致するときだけ。
- 本人性: 投稿者の staff 権限を `capabilityAllowed` で見る。登録 = `session_spawn`、`merge`/`deploy` 可 = `merge_pr`。
  権限を超える許可は不可に落としてスレッドで知らせる (初版の `authorize-confirmer` を流用)。

### 2. 読み取り

- port `GoalExtractionPort.extract(text) → { project?, goalText?, acceptance: string[], permissions: {merge,test,service,deploy}, actioTaskIds: string[], quotes: Record<field, string> }`。
- adapter は `claude -p` (既存の Claude CLI 呼び出しヘルパを使う。API キーを持たない) で JSON を返させる。
  時間切れは 60 秒以上にする (短いと無言で死ぬ)。
- 返った各項目は `extraction-guard.ts` (純関数) で **本文に根拠があるか** を検査する: `quotes[field]` が投稿本文 (正規化後) の部分文字列であること。
  根拠の無い項目は欠けとして扱う (CC-DG-INV-09)。プロジェクトは Cc の project registry で一意に解決できたときだけ採用。
- 構造化した書式 (行頭 `プロジェクト:` `ゴール:` `受入条件:` `許可:` `task:`) で書かれた投稿は LLM を通さず `structured-post-parser.ts` で読む。
  LLM が失敗・時間切れのときは下書きにして「読み取りに失敗した」と返し、構造化書式を案内する (推測で登録しない)。
- `draft-policy.ts` (純関数): 抽出結果 → `complete | missing:[project|goal|acceptance]`。

### 3. 下書きと聞き返し

- `daily_goal_drafts { id, business_date, source_message_id UNIQUE, author_user_id, guild_id, channel_id, thread_id?, text_parts JSON, extracted JSON, missing JSON, status (open|registered|expired), created_at, updated_at }`。
- 下書きにしたら元投稿にスレッドを作り、読み取れた項目と足りない項目を 1 通で返す。返信・元投稿の編集のたびに全文を読み直し、そろえば登録して下書きを registered に。
- 登録は初版の `service.confirmGoal` 相当に渡す (ゴールの `source_message_id` を保存し、同じ投稿から 2 件目を作らない)。
- 登録時、スレッドに読み取り結果 (プロジェクト・ゴール・受入条件・許可) を返す。

### 4. 起動

- `launch-policy` の 7:30 を撤廃: 登録したら即 due。`daily_goal.launch_time` 設定を削除。
- 依頼文 (`prompts.ts`) に締切時刻を入れる。

### 5. 業務日・締切・まとめ

- `business-day.ts` (純関数): `businessDateOf(now, boundary="04:00")`、`deadlineOf(businessDate, boundary)`。ゴールの `date` はこれで決める。
- `deadline-policy.ts` (純関数): 締切に達した running ゴールの一覧。stop-policy に 4 つ目の止まる条件 `deadline` を足す (時刻を受けるのはここだけ)。
- `day-summary.ts` (純関数): ゴール・確認記録・証跡・残り → `{ title, markdown }`。セッションの自己申告は「報告」として区別。
  目標なし・ゴール 0 件の日は `null` (記載しない)。下書きだけの日は下書き一覧だけのまとめ。
- `day-close.ts` (use case): 締切停止 (最後の証跡を集めて受入条件ごとの到達を記録) → まとめ → Memoria 記載 → チャンネル投稿。
  各段の intent を `daily_goal_days` に先に保存し、結果不明は照合してから再送 (CC-INV-03)。届かなければ `unwritten` で残し次の tick で再送。
- `daily_goal_days { business_date PK, no_goal_by?, no_goal_at?, reminder_state, reminder_message_id?, summary_markdown?, close_state (none|stopping|summarized|journaled|posted), diary_state, note_state, note_id?, error?, updated_at }`。
- まとめ投稿に「再送」ボタン (本人確認 + `session_control`)。
- port `MemoriaJournalPort`: `putDiarySection(date, source, {title, markdown})`、`getDiarySection(date, source)`、`createNote({external_id, title, markdown, source})`。
  HTTP adapter は Cc のサービス URL `memoria` から接続先を解決 (`src/config/service-urls.ts`)。契約は仕様「Memoria との契約」。

### 6. 9:00 通知

- `reminder-policy.ts` (純関数): `(now, day, hasGoal, hasDraft, noGoal) → notify | skip`。業務日の境界 + 5h (設定 `daily_goal.reminder_time` 既定 09:00) を過ぎ、まだ通知していない日だけ。
- 通知の intent を先に保存して 1 回だけ。

### 7. 撤廃

- `candidates.ts` と候補カード・候補の確定モーダル、`daily_goal.candidate_projects` 設定、`/co-daily-goal` コマンド登録 (`src/discord/commands/daily-goal.ts`)。
  テーブル `daily_goal_candidates` は DROP しない (新規に書かないだけ)。関連テスト・acceptance の対応も外す。

### 8. 設定

- 追加: `daily_goal.day_boundary` (既定 `04:00`)、`daily_goal.reminder_time` (既定 `09:00`)。
- 削除: `daily_goal.launch_time`、`daily_goal.candidate_projects`。

## 依存

- Memoria 側の API (`PUT/GET /api/diary/:date/sections/:source`、`POST /api/notes/from-text`) は Memoria の別 PR で入れる。
  Cc 側は port の契約に合わせて実装し、Memoria 未反映の間は `unwritten` で残る (失敗で落ちない)。

## テストと受入

- 純関数 (no-goal-policy / extraction-guard / structured-post-parser / draft-policy / business-day / deadline-policy / day-summary / reminder-policy / stop-policy の締切) と
  repository・use case (fake port) の vitest を同じ変更で書く。`cc.acceptance.json` の implementations に source / tests を対応付ける。
- 仕様の受け入れ基準を 1 項目ずつテストへ対応させ、PR 本文に対応表を書く。
- 実行してよいのは typecheck と build だけ。単体・統合・起動テストの実行と Cc の再起動はしない (登録テストは Revisor)。

## 自己検証 (PR 本文に結果を書く)

- `grep -rn "TODO\|FIXME\|not implemented" src/daily-goal-run` が 0 件。
- `*-policy.ts` / `business-day.ts` / `day-summary.ts` / `extraction-guard.ts` が `better-sqlite3` / `discord.js` / `process.env` を import していない。
- `launch_time` / `candidate_projects` / `co-daily-goal` が src に残っていない。
- 止まる条件で時刻を見るのが `deadline-policy` だけ。
