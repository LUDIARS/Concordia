# Concordia 本体を起動するための設定 (core)

## 目的

Concordia backend (loopback HTTP) を立ち上げ、 複数 AI セッションの登録 / 進捗共有 / lost 検知 / 終了レポートを使えるようにする。 これが他の全機能 (Discord / observability / spawn) の土台。

## 設定キー

正本は [`config-reference.md` §1](config-reference.md#1-コア-本体起動)。 本体起動で押さえるべきもの:

| キー | 既定値 | いつ変える |
|------|--------|-----------|
| `CONCORDIA_HOST` | `127.0.0.1` | 基本変えない (認証なし loopback 前提)。 |
| `CONCORDIA_PORT` | `17330` | port 衝突時のみ。 |
| `CONCORDIA_DB_PATH` | `<cwd>/concordia.db` | DB を別ボリュームに置きたいとき。 |
| `CONCORDIA_LOST_AFTER_SEC` | `1800` | lost 判定を早めたい/遅くしたいとき。 |
| `CONCORDIA_ABANDONED_AFTER_SEC` | `86400` | 放置判定の閾値。 |
| `CONCORDIA_PURGE_AFTER_DAYS` | `90` | event 保持期間。 |
| `CONCORDIA_SWEEPER_INTERVAL_MS` | `60000` | 判定周期。 |

## 手順

1. 依存インストールとビルド前提:

   ```bash
   npm install
   ```

2. 起動 (dev は backend + Vite を `concurrently` で同時起動):

   ```bash
   npm run dev          # backend(17330) + frontend
   # または backend 単体
   npm run dev:backend  # tsx watch src/server.ts
   # production
   npm run build && npm run start   # node dist/server.js
   ```

   `.env` は任意。 無ければ全キーが既定値で動く (`src/shared/config.ts:loadConfig()`)。

3. 起動確認: ログに `Concordia listening` (`host` / `port` / `dbPath`) が出る (`src/server.ts:303`)。 ブラウザで Vite frontend (dev は別 port) を開くと全 active session が見える。

4. session 連携を使うには各 AI セッション側に hook を仕込む → [`docs/hooks-claude-code.md`](../../docs/hooks-claude-code.md) / [`docs/hooks-codex-cli.md`](../../docs/hooks-codex-cli.md)。

## 起動時に走るもの (参考)

`startBackend()` (`src/server.ts`) は backend を上げると同時に以下を起動する。 これらは本体の一部で個別の有効化フラグは無い (observability と Discord だけ別 — 各ガイド参照):

- **sweeper** — `CONCORDIA_SWEEPER_INTERVAL_MS` 周期で lost / abandoned / purge を判定。
- **rule engine / proposer** — chat 投稿ルール。 `CONCORDIA_DISABLE_CLAUDE=1` で LLM 呼び出しを止められる。
- **daily / stat スケジューラ** — 日次レポート + 10 分毎の stat 収集。
- **WebSocket `/ws`** — eventBus を connected client に broadcast。 `?session=<id>` 接続は `ws_clients` をインクリメントし、 sweeper の lost 判定から除外される。

## 注意点

- **DB は cwd 直下**: ユーザ home を汚さない方針 (`defaultDbPath()`)。 `concordia.db` は `.gitignore` 済。 WAL モードなので `-wal` / `-shm` も同階層に出る。
- **再起動時の整合性**: プロセス再起動で in-memory の WS 接続が消えるため、 boot 時に `sessions.ws_clients` を 0 リセットする (`server.ts:115`)。
- **dev background 起動**: cwd に [`dev-process.md`](../../dev-process.md) があるので `npm run dev` の background 起動が許可されている (LUDIARS dev-server policy)。
- **idle ≠ lost**: Stop hook が turn 毎に発火するので、 lost 既定は 30 分と長め。 短くしすぎると active session が誤って lost 判定される。

## トラブルシュート

| 症状 | 原因 / 対処 |
|------|------------|
| 起動で即落ち / `claude CLI` 系エラー (Windows) | git-bash パス未設定。 [windows.md](windows.md) を参照。 |
| port 17330 が listen できない | 別プロセスが掴んでいる。 `CONCORDIA_PORT` を変えるか古い node を kill。 [windows.md](windows.md) の port 節。 |
| session が登録されない | hook 側の `CONCORDIA_HOOK=1` opt-in 漏れ。 hook ガイド参照。 |
| active session がすぐ lost になる | `CONCORDIA_LOST_AFTER_SEC` が短すぎる。 既定 1800 に戻す。 |

## 関連

- [config-reference.md](config-reference.md) — 全キー正本
- [`spec/service-schema.md`](../interface/service-schema.md) — DB スキーマ / API / 用語
- [windows.md](windows.md) — Windows 固有の起動設定
