---
task: session-auto-succession
project: Concordia
kind: 実装
status: review
created: 2026-11-10T00:00:00.000Z
source_session: lictor-04ebb767-418c-4294-b131-c7b671175582
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---

# コンテキスト量での自動引き継ぎと、ゲートで止まった別リポを担当エージェントへ渡す

## 実装内容

設計: `spec/feature/session-auto-succession.md` (neco 2026-11-10 指示)。DB migration なし (親子の対応は session metadata)。

### UX
- Claude セッションの占有が設定窓 1M × 70% (= 700,000 トークン) を超えたら、待機中に限り次セッションへ自動で handover する。チャンネル見出しは `🤝 次セッション引き継ぎ資料 (自動: ctx 72%)`。Codex は自前のコンパクションがあるので対象外。
- 起動 cwd と違う登録リポの編集がゲート (`task-branch` / `contract-incomplete` / `outside-scope` の deny / `max-repos`) で止まったら、deny 応答 (reason と hit の suggestion) に repo-brief の書き方を載せる。親が書いた repo-brief を transcript から受け取り、その checkout (worktree ならその worktree) を cwd にした担当エージェントを親と同じ provider (Claude / Codex) で立てる。
- リポが分岐したとき (active_repos) は、待機中の親へ担当の提案を 1 回 inject する。
- 担当が立った・終わったときは親へ inject とチャンネル 1 行。終了時は担当の最後の発言の抜粋と PR 番号を親へ届ける。
- `GET /v1/sessions/:id/repo-agents` (担当一覧 / 子からは親) と `POST /v1/sessions/:id/repo-agents` (手動依頼)。

### 不変条件 (spec §5)
- INV-1: 自動引き継ぎは 1 セッション 1 回、担当は (親, checkout) につき同時に 1 つ。どちらも記録先行 (`metadata.auto_handover` / `metadata.repo_agents[]`) で、結果不明でも再送しない。
- INV-2 / INV-2b: 占有が観測できなければ引き継がない。閾値は設定窓から計算し観測の窓から推測しない。自動引き継ぎは Claude のみ。
- INV-3: 自動の依頼 inject は待機中 (最後の frame が完了境界かつ 60 秒静止) だけ。
- INV-4: `/clear` は発火しない。
- INV-5: 担当は repo-brief を受け取った checkout にだけ立てる (600 秒で `brief_missing`)。
- INV-6: 安全上の deny (main push・秘密・危険コマンド・相談境界など) は契機にしない。deny 自体は変えない。
- INV-7: 担当は親と同じ provider。

### 境界と再利用
- 新規は `src/control/succession/` (純関数: context-handover-policy / session-idle / repo-agent-policy / repo-brief / repo-agents-state / auto-handover-metadata / managed-session / spawn-budget、ユースケース: session-succession-service / session-handoff-author / repo-agent-service / auto-succession-watcher、adapter・配線: succession-settings / session-succession-wiring / succession-runtime)。
- 既存 `src/api/sessions/end.ts` の relictor / handover の機構を `SessionSuccessionService` に抽出し、route は HTTP 変換だけにした (409 重複・spawn 失敗時の pending 破棄・保険 kill はそのまま)。route と監視は同じインスタンスを共有する。
- pending succession (`pending-relictor.ts`) に kind `repo-agent` を足し、子の登録 (lifecycle) で `repo_agent_of` を焼いて親の行を active にする。
- 自動経路の spawn は直近 60 秒に 2 件まで (自動引き継ぎと担当で共有)。超過分は次の走査へ回す。
- control 層から cost / api を import しない (占有の読み取りと `toSpawnProvider` は bootstrap から注入)。
- タスクワークフロー (taskflow) の task state は作らない・変えない。

### 設定と復旧
- env: `CONCORDIA_AUTO_HANDOVER` / `_WINDOW_TOKENS` (1000000) / `_PCT` (70) / `CONCORDIA_AUTO_SUCCESSION_QUIET_SEC` (60) / `CONCORDIA_REPO_AGENTS` / `_MAX` (3) / `_BRIEF_TIMEOUT_SEC` (600)。設定一覧 (session セクション) にも登録。
- 無効化は `CONCORDIA_AUTO_HANDOVER=0` / `CONCORDIA_REPO_AGENTS=0` (走査ごとに読み直すので再起動不要)。
- Cc 再起動で pending が消えた `spawning` 行は 5 分で `spawn_failed` に倒す。誤って立った担当は通常の終了で畳む。

### 検証
- 実施: `tsc --noEmit` (src は通過。tests は既存の `tests/qs-lock.test.ts` の 1 件のみで今回と無関係)、dependency-cruiser (今回の変更による違反なし。既存 11 件)、Anatomia `pr-review` (5 ゲート pass・dual-layer pass)。
- 未実施: テストの実行とサービス再起動 (人間の許可範囲外のため)。テストはすべて fake port / in-memory DB で書いた。
- 未決 (spec §9): 担当上限 3 は既定値のまま。担当の子へ Goal & Go・マージ許可は引き継がず、brief に書かれた許可範囲だけを渡す。
- Actio task は未照合 (unknown)。

## 受け入れ条件

- `decideContextHandover`: 表 2.1 の各行。699,999 は skip・700,000 は handover・Codex は常に skip (`context-handover-policy.test.ts`)。
- `isRepoMismatchDenial`: 対象 rule は真、安全上の rule・warn は偽 (`repo-agent-policy.test.ts`)。
- `decideRepoAgentHandoff`: 起動 cwd と同じ checkout・未登録リポ・worktree 正規化・既存担当・上限・再帰防止 (`repo-agent-policy.test.ts`)。
- `parseRepoBriefs`: 複数ブロック・不正 JSON・未登録 checkout・空 brief (`repo-brief.test.ts`)。
- `repo-agents-state`: 図の遷移だけを許し、同じ checkout の重複行を作らない (`repo-agents-state.test.ts`)。
- ゲート deny → 行 `requested` + suggestion に依頼文の書き方。同じ checkout の 2 回目は §3.5 の案内 (`repo-agent-service.test.ts`, `harness-session-repo-agents.test.ts`)。
- repo-brief 受領 → pending 登録 → spawn (provider 親と同じ) → 子登録で依頼文 inject と親子 metadata の結合 (`repo-agent-service.test.ts`, `succession-enrollment.test.ts`)。
- spawn 失敗で `spawn_failed`・pending 破棄。brief timeout で `brief_missing` (`repo-agent-service.test.ts`)。
- 子の終了で親へ抜粋が届き、行が `ended` (`repo-agent-service.test.ts`, `succession-runtime.test.ts`)。
- `/:id/handover` `/:id/relictor` の既存挙動 (409 重複・spawn 失敗時の pending 破棄) が回帰しない (`session-succession-service.test.ts`, `routes.test.ts`)。
- watcher が判定 → 記録 → 実行の順で呼び、1 走査の spawn 上限を守る (`auto-succession-watcher.test.ts`)。
