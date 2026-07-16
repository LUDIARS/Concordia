# Cc セッション安定性 — 問題点一覧と対応状況

- Date: 2026-07-09
- Source: [spec/plan/cc-stability-analysis.md](../cc-stability-analysis.md) (詳細解析・根拠・再現シナリオはこちら)
- Status: P0 全件 + P1 一部を実装済み。 残りは対応方針のみ記載 (未実装)

「Cc がよく落ちる」を構成する問題の一覧。 詳細な故障モード分解・タイミング表・
連鎖シナリオは解析資料側にあり、 本書は **問題単位の台帳** として対応状況を管理する。

## 凡例

- ✅ 対応済み (このリポジトリで実装済み)
- 🔲 未対応 (方針のみ確定)

---

## A. Concordia 本体プロセスのクラッシュ (全セッション同時死に見える)

| # | 問題 | 対象 | 状態 |
|---|------|------|------|
| A-1 | `unhandledRejection` / `uncaughtException` ハンドラが存在せず、未処理 rejection 1 発で本体が死ぬ | `src/server.ts` | ✅ `installProcessSafetyNet()` を追加。 ログ + `error.reported` へ流し、 プロセスは維持 |
| A-2 | Cc / 旧Codex headless worker の `spawn()` に `error` リスナーが無く、 `wt.exe`/lictor 不在で uncaughtException | `src/control/spawner.ts` | ✅ try/catch + `child.on("error")` を追加、 `error.reported` へ通知。旧headless Delegation adapter は 2026-07-16 に撤去 |
| A-3 | rules engine の async イベント購読 / async `setInterval` が未ガードで、 DB throw が rejection として escape | `src/rules/engine.ts` | ✅ body 全体を try/catch でガード (sweeper と同パターンに統一) |
| A-4 | Discord relay の `void (async () => {…})()` 2 箇所に `.catch` 漏れ (429 / Unknown Webhook で本体巻き添え) | `src/discord/bot.ts` (prompt relay / Slack inject mirror) | ✅ `.catch` を追加。 ★ `no-floating-promises` の lint 化は 🔲 |
| A-5 | SQLite `busy_timeout` が暗黙値のみ + 本体と cost-worker の 2 プロセス書き込み競合 | `src/db/schema.ts` | ✅ `busy_timeout = 5000` を明示。 ★ lease handoff 窓の二重書き込み解消は 🔲 |

## B. 健全な Cc セッションの誤 kill

| # | 問題 | 対象 | 状態 |
|---|------|------|------|
| B-1 | 一度 `lost` になると event/heartbeat を送り続けても `active` に戻れない (復帰は SessionStart のみ) | `src/api/sessions/*` | ✅ `reviveIfLost()` を追加し、 event / heartbeat / PATCH / WS 再接続で lost→active 復帰 + `revive` イベント記録 |
| B-2 | `purgeStale` が `ws_clients` を見ずに行 DELETE → reaper が「記録なき孤児」と誤認し、 動作中の claude.exe を `taskkill /F /T` | `src/db/sessions-repo.ts`, `src/control/reaper.ts` | ✅ purge に `ws_clients = 0` 条件を追加。 ★ reaper 側の transcript mtime 確認 (最終防壁) は 🔲 |
| B-3 | Concordia 再起動で `resetAllWsClients` が全 WS カウントをゼロ化 → agent-client 再接続 (1〜30s) 前に sweeper が lost 化。 reaper は起動直後に即走る | `src/bootstrap/core.ts`, `src/sweeper.ts`, `src/control/reaper.ts` | 🔲 起動猶予ウィンドウ (起動後 2〜3 分は lost 判定 / 孤児 kill を停止)。 B-1 の WS 再接続 revive で被害は大幅減 |
| B-4 | `.env.example` の lost 閾値 300s vs コード既定 1800s の不一致 (発症頻度 6 倍) | `.env.example`, README ほか | ✅ 1800 に統一、 ドキュメントの「5 分」記述を一掃。 ★ 運用中の実 env の確認は運用作業 |
| B-5 | PID 再利用を検証せず保存済み pid を `taskkill /F /T` (無関係プロセスのツリーを殺しうる) | `src/api/sessions/lifecycle.ts`, `src/control/stop-session.ts` | 🔲 kill 前にプロセス開始時刻 / イメージ名を照合 |
| B-6 | reaper の ended 猶予 300s < session-end 完了待ち 600s の不整合 (終了処理中に kill されうる) | `src/shared/config.ts`, `src/api/sessions/shared.ts` | 🔲 reaper 猶予 ≧ session-end タイムアウトに揃える |

## C. 本当のクラッシュの不可視化・無復旧

| # | 問題 | 対象 | 状態 |
|---|------|------|------|
| C-1 | spawn コマンド末尾の `& exit 0` が Cc の異常終了コードを常に 0 に洗浄 | `src/control/spawner.ts` (buildWtArgs) | 🔲 lictor 側で子プロセス exit code を取得し `POST /event {kind:"exit"}` で報告 (Lictor 側変更を伴う) |
| C-2 | 自動再起動が皆無 (lost→abandoned→purge と減衰するだけ。 relictor は手動 + active 限定) | `src/api/sessions/end.ts` | 🔲 exit 報告 / lost 検知トリガの opt-in auto-respawn (回数上限 + バックオフ付き) |

## D. hook 起因のハング / 激遅 (死んで見える)

| # | 問題 | 対象 | 状態 |
|---|------|------|------|
| D-1 | git `execSync` に timeout が無く、 SessionStart hook が無期限ブロックしうる | `tools/concordia-hook.mjs` | ✅ `timeout: 3000` を追加 |
| D-2 | backend 停止中も直列 fetch が各 1.5s タイムアウトし、 毎プロンプト 6〜9 秒フリーズ | `tools/concordia-hook.mjs` | ✅ 最初の接続失敗以降を short-circuit。 ★ fetch の並列化は 🔲 |
| D-3 | 非 prompt hook (edit / compact / session-end) の stdout がコンテキストへ毎回注入され肥大 | `tools/concordia-hook.mjs` | 🔲 edit hook の stdout 抑制 / サイズ上限 |
| D-4 | `CONCORDIA_TIMEOUT_MS` 非数値で NaN → 全 fetch 即 abort (報告が無音全滅) | `tools/concordia-hook.mjs` | ✅ 数値検証 + フォールバック |
| D-5 | `readFileSync(0)` は stdin が閉じないと永久ブロック | `tools/concordia-hook.mjs` | 🔲 (CC が pipe を閉じる限り実害なし。 呼出し規約に依存) |

## E. Discord 制御系の恒久停止 (落ちて見える / 操作不能)

| # | 問題 | 対象 | 状態 |
|---|------|------|------|
| E-1 | 通常イベント `ShardReconnecting` を fatal 扱いして bot を自壊 (復帰経路なし) | `src/discord/bot.ts` | ✅ teardown をやめログのみに。 ★ 真の切断 (ShardError/Disconnect) の上限付き自動再起動は 🔲 |
| E-2 | interaction ACK 先出し (deferReply/deferUpdate) の残存漏れ → `Unknown interaction` | `src/discord/commands/enter.ts`, `mmtask.ts`, `control.ts` | 🔲 該当ハンドラ冒頭へ defer を移動 + テスト固定 (問題ログ 2026-07-06 の方針を全面適用) |
| E-3 | 無限成長する Map/Set (promptRelayLast / error-fix lastSeen / cost-sampler seen) | `src/discord/bot.ts` ほか | 🔲 上限 / TTL 付き構造へ置き換え (クラッシュではなく長期稼働時のメモリ圧) |

---

## 実装済み変更の検証

- lost 復帰: `POST /event` / `POST /heartbeat` / WS 再接続で status が active に戻る (回帰テスト追加)
- purge 保護: `ws_clients > 0` の lost セッションが `purgeStale` で消えない (回帰テスト追加)
- spawn 失敗: spawnFn 注入で `error` イベントを発火させてもプロセスが落ちない (回帰テスト追加)
- rules engine: `deps.rules.list` が throw しても listener / tick が生存 (回帰テスト追加)
- 既存テストスイート + lint が green であること

## 未対応項目の推奨順序

1. B-3 起動猶予ウィンドウ (誤 kill の残存経路で最も踏みやすい)
2. C-1 + C-2 exit code 報告と auto-respawn (「本当に落ちた Cc」の検知と復旧 — Lictor 側変更を伴う)
3. E-2 ACK 先出しの全面適用 (ユーザー可視の操作失敗)
4. B-5 / B-6 kill の安全化、 A-4★ lint 化、 D-3 stdout 抑制、 E-3 メモリ上限
