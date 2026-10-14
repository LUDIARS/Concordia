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

### 2026-07-19 時点の残件一覧

2026-10-14 追記の一覧で置き換えた (spawn 経路と release 系は非同期化済み)。

## 実装状況 (2026-10-14 追記 — 再確認で見つかった残りの非同期化)

Pf フラグメント 01M4VTCS9JY3E7P8B3NSPXA59T の再確認 (main 72bf9409) で、 #357 の後に入った
リクエスト経路の同期 fs (`src/api/register-web.ts` の web-hosts GET/PUT、
`src/api/sessions/lifecycle.ts` の `existsSync(input.repo_path)`) と、 前回 A-5 で残件とした
spawn 経路が残っていた。 本追記の PR で次を非同期化した (挙動・エラー時の応答・順序は変えない)。

- リクエスト経路: web-hosts の読み書き / セッション登録の repo_path 確認 / work-submission の
  本体 checkout 解決 (`mainCheckoutPath` → `routeForRepo` → `/v1/implementation-tools/submission-route`) /
  バグバウンティ Bot の内部トークン読み (要求ごと) / setup のスキル md 読み (一度だけ読みメモ化) /
  ハーネスの DDD 証跡・受入検査 (`hasDddEvidenceAsync` / `checkCodeAcceptance`) / pre-compact の
  augur.contracts.json 読み (`ReliabilityHookService.handle` を async 化) / delegation の完了証跡検査
  (`verifyCompletionEvidence` の checkout 確認・契約ファイル検出・Augur CLI 解決・マニフェスト読み) /
  委託 prompt の別リポ md 同梱 (`buildExternalDocBundle`) / Augur CLI 解決 (`AugurTools.cli`) /
  claude 起動先の解決 (`resolveClaudeLaunch` / `claudeLaunch`) / Test Forum QA の clone 解決 /
  domain-review の Edge 解決 / 相談の CODEX_HOME 準備 / deploy・release 確認の clone 解決と build 判定。
- spawn 経路 (前回 A-5 残件): `spawnSession` を Promise 化し、 cwd 検証 (`validateCwd` /
  `resolveSpawnCwd` / `resolveAgentHomeCwd`)、 内部 Agent プラグインと session Git hooks の書き出し、
  Lictor launcher の解決 (`resolveLictorLauncher`、 spawn ごとに 1 回だけ解決して各起動方式へ渡す)、
  `spawn-target` / `spawn-cwd` の stat、 process 起動のログ dir 作成を非同期化した。 呼び出し元
  (spawn API / relictor・handover / fork / chores / management / delegation launcher / budget resume /
  error-fix) はすべて await する。 error-fix は従来どおり「起動直後は null を返して次の drain で拾う」。
- interval tick / イベント処理: WAL guard の WAL サイズ取得、 nightly vacuum の前後サイズ計測、
  ログ退避 zip の圧縮 (`buildZip` を `zlib.deflateRaw` の非同期版に)、 director 巡回の対象 clone 解決、
  federation の設定キャッシュ書き込み (到着順を保つため Promise チェーンで直列化し、 書き込み後に
  `onConfig` を呼ぶ順序を維持)、 admin の repo 走査 (`scanRepos`)。

再発防止: `tests/runtime-sync-io.test.ts` が `src/` (テスト・契約を除く) をコメント除去後に走査し、
同期 fs / child_process / zlib の呼び出しが下の許可リスト外のファイルにあるか、 許可リストの件数を
超えたら落ちる。 許可リストが実数より多い (不要になった許可が残っている) 場合も落とす。
共通の非同期プローブは `src/shared/fs-async.ts` の `pathExists` (existsSync と同じ判定)。

### 残した同期 fs 呼び出し (理由つき列挙、 2026-10-14 時点)

`tests/runtime-sync-io.test.ts` の許可リストと同じ内容。 件数はファイルごとの上限。

**B: boot 時のみ**
- `src/bootstrap/core.ts` (2) `loadDotEnv` — `.env` の起動時読み込み
- `src/shared/config.ts` (1) `loadConfig` — 設定ファイルの起動時読み込み
- `src/shared/secret-box.ts` (5) `loadSecretBox` — 起動時 1 回の secret key 生成/読取 (wx 排他生成の原子性のため同期)
- `src/db/index.ts` (1) `openDb` の DB ディレクトリ作成
- `src/control/token.ts` (7) spawn トークンファイル — 認証初期化時のみ
- `src/api/skills.ts` (1) スキル md — 初回だけ読みモジュール内でメモ化
- `src/api/register-web.ts` (2) `web/dist/index.html` — ルート登録時に 1 回だけ読む (web-hosts の読み書きは非同期化済み)
- `src/bounty/operator-credentials.ts` (5) `ensureBountyOperatorToken` — 起動時に 1 回 (Bot の要求ごとの読みは非同期)
- `src/federation/config-cache.ts` (1) オフライン設定キャッシュの読み — site client 起動時に 1 回 (書き込みは非同期)
- `src/processes/manager.ts` (1) logs dir 作成 — ProcessManager の構築 (起動時 1 回)。 起動ごとの dir 作成は非同期
- `src/shared/log-file-rotation.ts` (6) logger のモジュール初期化時、 pino が open する前に 1 回だけ世代交代
- `src/platform/reaction-workflow-loader.ts` — 前回一覧から削除 (現行コードに同期呼び出しが無い)

**C: CLI / 別プロセスの worker エントリポイント**
- `src/chat-worker.ts` / `src/cost-worker.ts` / `src/workflow-worker.ts` (各 2) worker プロセス起動時の `loadDotEnv`
- `src/drop-obsolete-excubitor.ts` (4) DB 移行 CLI
- `src/harness/supervisor-cli.ts` (17) hook ごとに起動する短命の supervisor CLI
- `src/harness/ddd-evidence.ts` (4) 同期版 `hasDddEvidence` は supervisor-cli 専用。 サービス内は `hasDddEvidenceAsync`
- `src/control/inject-source-apply.ts` (2) `dist/control/inject-source-apply.js` CLI
- `src/developer-tools/migration-preflight/git.ts` (1) / `ontime-runtime.ts` (2) migration-preflight CLI
- `src/developer-tools/actio-sync-migration/run.ts` (3) / `legacy-documents.ts` (1) / `legacy-activity.ts` (1) actio-sync-migration CLI

前回 C に入れていた `src/release/build.ts` / `src/release/clone-paths.ts` は director 巡回 (interval tick)
と deploy・release 確認 (リクエスト) から呼ばれていたので非同期化した。

**D: テスト**
- 各 `*.test.ts` のフィクスチャ準備 (検査の対象外)
- `src/config/settings/coverage-scan.ts` (3) 設定カバレッジのテストだけが使う静的ソース走査

**better-sqlite3 (対象外)**
- ネイティブアドオンの同期 API はライブラリ設計上の制約であり本タスクの対象外
  (`transcript-logs-repo.flushSync` 等の名前は DB 書き込みで fs ではない)。
