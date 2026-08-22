---
task: full-async-io
project: Concordia
kind: 実装
status: done
created: 2026-07-17T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 538
pr_number: 357
actio_task_id: null
memory_links: []
---
# ランタイム I/O の完全非同期化 — イベントループを止めない

## 目的

Concordia のランタイム経路 (request / interval tick / spawn) に残る同期 fs I/O を
fs/promises 化し、「絶対にプロセスを止めない」状態にする (neco 指示:
「Sync 系の関数を全て除外し完全非同期にする」)。

実測根拠:
- findCodexTranscript の head 読み+キャッシュ化後も 1 スキャン 8.2 秒
  (8,601 ファイルの readdirSync + head open、Windows+AV で open が重い) が
  同期実行され、負キャッシュ TTL 60s で再発する。
- `DELETE /v1/sessions/:id` が実測 55.4 秒 (2026-07-16 22:15) —
  end-session フロー内に同期読みが残っている。経路を特定して潰す。
- cost/ ログ集計は過去に 16-17 秒ブロックの前科。

## 完了条件

- A-1/A-2: cost/ ログ集計 (log-usage / channel-cost-cache / windowed-usage-cache /
  session-usage-cache / log-totals-cache) の同期 fs を全 async 化。
  SessionWindowReader / ChannelCostReader 契約を Promise 化し、
  org-cost / channel-cost / cost-report / getMonitorSnapshot /
  Discord・Slack bot まで await 連鎖を通す。
- A-3: リクエスト経路 (reaction-workflow / discord egress / mcp readers /
  session-logs reader / delegation service / codex-cli transcript 解決) を async 化。
  AgentProvider.transcriptPath / parseTranscript 契約を async 化し、
  負キャッシュを指数バックオフ化 (60s 開始 ×2、最大 30 分/sessionId)。
  DELETE /v1/sessions の 55 秒ブロックの犯人を特定して排除。
- A-4: interval tick (sweeper / stalled-session-nudge / md-store /
  anthropic-oauth-usage) の同期 fs を async 化。
- A-5 (余力): spawn 経路の existsSync/statSync 等。やり切れない分は残件報告。
- B (boot 時のみ) / C (CLI) / D (テスト) / better-sqlite3 は対象外。
- `npx tsc --noEmit` 緑 + `npx vitest run` 緑 (real-git 系フレークは単独再実行で判断)。
- 残した同期 fs 呼び出しを理由つきで列挙。

## スコープ (編集可ディレクトリ)

- src/ (ただし src/personas/ と persona 関連コードは並行セッションのため触らない)
- tests/

## 実装状況 (2026-07-19 追記)

PR #357 (`refactor: ランタイム I/O を完全非同期化 — イベントループを止めない`) で
A-1〜A-4 を含む本体を main にマージ済み: cost/ 系 (log-usage / channel-cost-cache /
windowed-usage-cache / session-usage-cache / log-totals-cache / context-estimate /
session-cost) の全 async 化、SessionWindowReader / ChannelCostReader /
UsageSampleReader 契約の Promise 化と org-cost / cost-report / getMonitorSnapshot /
Discord・Slack bot までの await 連鎖、AgentProvider.transcriptPath / parseTranscript
の async 化、負キャッシュの指数バックオフ化 (60s ×2、最大 30 分/sessionId、
`src/providers/codex-cli.ts` の `MISS_CACHE_TTL_MS` / `MISS_CACHE_MAX_TTL_MS`)、
`DELETE /v1/sessions/:id` 55 秒ブロックの犯人 (runSessionEndFlow → generateReport →
summarizeSessionUsage 内の同期 transcript 全量読み) の特定・排除、sweeper /
stalled-session-nudge / session-logs reader / collaboration-context /
reaction-workflow / discord egress / mcp readers / delegation prompt 書き出し /
anthropic-oauth-usage / md-store / subsidiary budget の async 化、spawn 経路の一部
(dev-process-md / ProcessManager.startFromRepo·startOne / session-channel export /
register-core project 解決) も async 化。

Memoria task id 526/527/528/538 の統合対応 (本 md 群) の一環として 2026-07-19 に
独立検証・追加対応した:

- 再検証: `npx tsc --noEmit` (tsconfig.json / tsconfig.test.json 両方) /
  `npx vitest run` (240 files / 1681 tests, 1ad70af 時点の 1646 から増加) /
  `npx depcruise src` (546 modules, violation 0) / `npm run build`
  (backend tsc + spec-index + web vite build) すべて green。
  1ad70af (#357 マージ) 以降の 8 コミットに sync fs I/O の再混入なし
  (discord bot / persona 撤去 / forum tag 関連で fs 呼び出し追加なし)。
- A-5 追加対応 1 件: `src/rules/claude-runner.ts` の `runClaude` が
  Windows git-bash 候補パス解決に `existsSync` を毎呼び出しで同期実行していた
  (rule engine / report 生成 / delegation / reaction-workflow の agentic 記録から
  高頻度に呼ばれるリクエスト経路)。`node:fs/promises` の `access` + プロセス内
  メモ化 (`resolveGitBashPath`) に変更し、以後の呼び出しでは fs I/O 自体を行わない。
  `src/rules/claude-runner.test.ts` を新規追加 (3 tests)。

### 残した同期 fs 呼び出し (理由つき列挙)

**B: boot 時のみ (対象外)**
- `src/bootstrap/core.ts` `loadDotEnv` (existsSync/readFileSync, `.env` 起動時読み込み)
- `src/shared/config.ts` `loadConfig` (existsSync/readFileSync, 設定ファイル起動時読み込み)
- `src/shared/secret-box.ts` `loadSecretBox` (existsSync/readFileSync/openSync/writeSync/
  closeSync — 起動時 1 回の secret key 生成/読取。wx 排他生成の原子性のため意図的に同期)
- `src/db/index.ts` (mkdirSync, DB ディレクトリ作成は openDb 起動時 1 回)
- `src/control/token.ts` (トークンキャッシュファイル — 認証初期化時のみ、リクエスト
  ホットパスではない)
- `src/api/skills.ts` / `src/api/setup.ts` (readFileSync だが module 内メモ化済みの
  スキル md 読み込み — 初回のみ、以後はメモリ上のキャッシュを返す)
- `src/platform/reaction-workflow-loader.ts` (existsSync — RWF プラグイン有無判定、
  bot 起動時の `initReactionWorkflow` 1 回のみ)

**C: CLI / 別プロセスの worker エントリポイント (対象外)**
- `src/cost-worker.ts` / `src/workflow-worker.ts` / `src/chat-worker.ts` の
  `loadDotEnv` (各 worker プロセス起動時 1 回、main イベントループとは別プロセス)
- `src/drop-obsolete-excubitor.ts` (DB 移行 CLI スクリプト)
- `src/release/build.ts` / `src/release/clone-paths.ts` (confirm/release フローの
  npm build 判定・clone path 解決。ユーザ起動の確認テストごと 1 回の軽量 existsSync/
  JSON 読みで、10 分周期 tick のような繰り返しホットパスではない。A-3 完了条件に
  明示された対象 [reaction-workflow/discord egress/mcp readers/session-logs
  reader/delegation service/codex-cli] には含まれない)

**A-5 (余力、未対応分の残件報告): spawn 経路**
- `src/control/spawner.ts` (`existsSync`/`statSync` — workspace root 解決・cwd
  検証。spawn リクエストごとに数回の単発 stat で、事故実績のあった「数千ファイル
  の全量 walk」とは性質が異なる。呼び出しチェーンが `resolveAgentHomeCwd` 等
  複数箇所から同期関数として呼ばれており、async 化は型シグネチャの連鎖変更を
  伴うため本 PR では見送り、残件として報告する)
- `src/control/spawn-target.ts` (`existsSync`/`statSync` — worktree path 検証。
  spawner.ts と同じ理由で残件)
- `src/work/repo-scan.ts` (`existsSync`/`statSync` — admin の repo 一覧/scan
  機能。ユーザ起動のオンデマンド操作であり、interval tick や spawn の主経路
  ではないため優先度を下げて残件とする)

**D: テスト (対象外)**
- 各 `*.test.ts` のフィクスチャ準備 (`mkdtempSync`/`writeFileSync`/`rmSync` 等)。
  テストプロセス内のみで完結し、本番ランタイムには含まれない。

**better-sqlite3 (対象外、明記どおり)**
- ネイティブアドオンの同期 API はライブラリ設計上の制約であり本タスクの対象外。
