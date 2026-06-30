---
type: interface
title: "Concordia — Service Schema"
description: "Concordia のサービス全体スキーマ仕様。SQLite データモデル (sessions / session_events / session_reports / processes / process_logs)、REST API (セッションライフサイクル・レポート・プロセス管理)、イベント種別、lost 検知・リカバリ・resume フロー、および v0.2 の F8 managed processes (dev-process.md 起動・SSE ストリーミング) を定義する。version: 0.1.0-draft。"
service: concordia
domain: http-interface
tags:
  - typescript
  - sqlite
  - rest-api
  - websocket
  - lifecycle
  - state-machine
  - spawn
  - relay
status: wip
related:
  - ../feature/multi-provider.md
updated: 2026-06-30
---


# Concordia — Service Schema

最終更新: 2026-05-02 / version: 0.1.0-draft

---

## 1. 用語

| 用語 | 意味 |
|------|------|
| **session** | 1 回の AI コーディングエージェント起動 (Claude Code の起動 1 回 = 1 session) |
| **provider** | AI agent の種別。 `claude-code` / `gemini-cli` / `codex-cli` / `local-llm` (Lictor ネイティブ local-agent) / `unknown` |
| **repo_origin** | git remote origin URL (例: `https://github.com/LUDIARS/Foo`)。 識別キー |
| **host** | ユーザの PC hostname (multi-PC 想定) |
| **lost** | heartbeat 5 分以上途絶 = lost にマーク。 24h で `abandoned` |
| **transcript** | provider 固有の session 記録ファイル (Claude Code なら jsonl) |

---

## 2. データモデル

```sql
-- セッション (1 行 = 1 起動)
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,             -- agent が払い出す session_id
  provider        TEXT NOT NULL,                -- claude-code / gemini-cli / codex-cli / local-llm / unknown
  repo_path       TEXT NOT NULL,                -- 絶対パス (cwd)
  repo_origin     TEXT,                         -- git remote origin (NULL も可)
  branch          TEXT,                         -- git branch (start 時 + 任意 update)
  host            TEXT NOT NULL,                -- hostname
  started_at      INTEGER NOT NULL,             -- unix sec
  ended_at        INTEGER,                      -- NULL = active or lost
  status          TEXT NOT NULL,                -- active / ended / lost / abandoned
  last_seen_at    INTEGER NOT NULL,             -- 最終 heartbeat (event 受信)
  current_task    TEXT,                         -- TodoWrite active item の自由文 / JSON
  transcript_path TEXT,                         -- ~/.claude/projects/.../<id>.jsonl
  metadata        TEXT                          -- JSON (model, version, etc.)
);
CREATE INDEX idx_sessions_repo_active ON sessions(repo_origin, status);
CREATE INDEX idx_sessions_status      ON sessions(status, last_seen_at);

-- イベント (prompt / edit / compact / etc.)
CREATE TABLE session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,                    -- 種別 (§3 参照)
  payload     TEXT NOT NULL                     -- JSON
);
CREATE INDEX idx_events_session ON session_events(session_id, ts);

-- 終了レポート (1 session = 0..1 row)
CREATE TABLE session_reports (
  session_id   TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  summary_md   TEXT NOT NULL,                   -- LLM 生成 markdown
  bullets      TEXT NOT NULL,                   -- 構造化 JSON
  duration_sec INTEGER NOT NULL,
  metadata     TEXT                             -- JSON (file_changes, tool_count, etc.)
);
```

---

## 3. event kinds

| kind | 発生タイミング | payload |
|------|---------------|--------|
| `start`            | SessionStart hook | `{ provider, host, cwd, branch }` |
| `prompt`           | UserPromptSubmit hook | `{ summary, length }` (本文は保管しない) |
| `edit`             | PostToolUse (Edit/Write/MultiEdit) | `{ file, lines_added, lines_removed }` |
| `tool_call`        | PostToolUse (任意 tool) | `{ tool, success, duration_ms }` |
| `task_update`      | TodoWrite or PATCH /sessions/:id | `{ active, pending, completed }` |
| `compact`          | PreCompact hook | `{ ranges, kept_messages }` |
| `lost`             | sweeper background job | `{ last_seen_at, last_event_kind }` |
| `recovered`        | jsonl reader | `{ jsonl_lines, last_tool_use }` |
| `end`              | Stop hook | `{ duration_sec }` |
| `note`             | API 直叩き (任意) | `{ text }` |

---

## 4. API

base: `http://127.0.0.1:11111`

### 4.1 セッションライフサイクル

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/v1/sessions` | 登録 (start hook 相当)。 同 repo の peers + lost candidates を返す |
| `GET`  | `/v1/sessions` | 一覧。 query: `?repo_origin=&host=&status=&provider=` |
| `GET`  | `/v1/sessions/:id` | 詳細 (recent events 含む) |
| `PATCH`| `/v1/sessions/:id` | `current_task`, `branch` を update |
| `POST` | `/v1/sessions/:id/heartbeat` | last_seen_at を更新するだけ |
| `POST` | `/v1/sessions/:id/event` | event を append |
| `POST` | `/v1/sessions/:id/resume` | lost session を引き継ぐ |
| `POST` | `/v1/sessions/:id/abandon` | 明示的に放棄 (resume 候補から外す) |
| `DELETE` | `/v1/sessions/:id` | end + report 生成トリガー |

### 4.2 レポート

| Method | Path | 用途 |
|--------|------|------|
| `GET`  | `/v1/reports/:session_id` | レポート取得 (markdown + bullets) |
| `POST` | `/v1/reports/:session_id/regenerate` | 再生成 (LLM や aggregation を再実行) |

### 4.3 monitor / 管理

| Method | Path | 用途 |
|--------|------|------|
| `GET`  | `/v1/monitor` | 全 repo / 全 host / 全 provider の active 一覧 (Web UI 用) |
| `GET`  | `/health` | 死活確認 |
| `POST` | `/v1/sweeper/run` | 手動 sweeper 実行 (debug) |

---

## 5. POST /v1/sessions の挙動

```jsonc
// request
{
  "id":           "<session_id>",     // agent 払い出し. 衝突なら 409
  "provider":    "claude-code",
  "repo_path":   "E:\\Document\\Ars\\Foo",
  "repo_origin": "https://github.com/LUDIARS/Foo",  // null 可
  "branch":      "main",                            // null 可
  "host":        "DESKTOP-XYZ",
  "transcript_path": "C:\\Users\\u\\.claude\\projects\\...\\sess-1.jsonl"
}

// response 200
{
  "session": { /* 上で登録した row */ },
  "peers": [                          // 同 repo_origin で active な他 session
    { "id": "...", "host": "...", "branch": "feat/x", "current_task": "...", "started_at": ... }
  ],
  "lost_candidates": [                // 同 repo_origin + 同 host で lost 状態の session
    { "id": "...", "branch": "feat/x", "last_seen_at": ..., "current_task": "..." }
  ],
  "advisory": {                        // AI に注入する追加コンテキスト
    "active_peer_count": 1,
    "branch_conflict": true,           // 同 branch で他 session 動作中
    "recommend_worktree": true,        // F6: worktree 自動化推奨
    "worktree_command": "git worktree add ../Foo-sess-2 main"
  }
}
```

`advisory` は SessionStart hook が `additionalContext` として AI に流すための判断材料。

---

## 6. lost 検知 + recover

### 6.1 sweeper

background job (1 分周期) で `status=active AND last_seen_at < now - 5min` を検出 → `status=lost` に更新 + `lost` event 追加。

### 6.2 jsonl recovery

lost session の `transcript_path` から最終状態を復元する:

```typescript
interface RecoveryInfo {
  jsonl_lines: number;
  last_message_role: "user" | "assistant" | "tool_result";
  last_tool_use?: { tool: string; input: object; ts: number };
  last_text_summary?: string;       // 最終 assistant message から最初の 200 文字
  todos?: Array<{ status: string; subject: string }>;  // 最後の TodoWrite
}
```

API: `POST /v1/sessions/:id/recover` を呼ぶと `recovered` event を追加 + recovery 情報を session.metadata に書き込む。 sweeper が lost 化した直後に自動で 1 度走る。

provider ごとの jsonl format は `src/providers/<name>.ts` の `parseTranscript()` で吸収。

### 6.3 resume

```jsonc
// POST /v1/sessions/<old-id>/resume
{
  "new_session_id": "<new-id>",
  "new_provider":   "claude-code"
}

// response: 旧 session の current_task と最終 todos を新 session にコピー
{ "old": {...}, "new": {...} }
```

---

## 7. report 生成

`DELETE /v1/sessions/:id` 時に同期生成 (response に含めて返す)。

### 7.1 構造化集計 (`bullets`)

```jsonc
{
  "duration_sec": 4321,
  "events": { "prompt": 12, "edit": 30, "tool_call": 45, "compact": 1 },
  "files": {
    "edited": ["src/foo.ts", "tests/foo.test.ts"],
    "created": ["src/new.ts"],
    "deleted": []
  },
  "todos": { "completed": 5, "in_progress": 1, "pending": 0 },
  "branches": ["feat/x"],
  "outcome": "ended" | "lost" | "abandoned"
}
```

### 7.2 LLM サマライズ (`summary_md`)

Anthropic SDK で集計 + 主要 event 抜粋を `claude-haiku-4-5` 等の haiku model に投げる。 入力 tokens を抑えるため:

- prompt event は `summary` (1 文要約) のみ使う、 本文は使わない
- edit event は file path のみ
- 最後の compact event の `kept_messages` を文脈ヒントに使う

出力例:
```markdown
## セッションサマリ
- repo: LUDIARS/Foo (branch feat/x)
- 期間: 2026-05-02 09:00 〜 12:01 (約 3 時間)
- 主な作業: src/foo.ts のリファクタ、 test 追加 (5 件 pass → 5 件 pass)
- ...
```

LLM が使えない環境 (API key 未設定) では `summary_md` を構造化集計から template で組む簡易フォールバック。

---

## 8. worktree 自動化 (F6)

### 8.1 検出条件

`POST /v1/sessions` 時に同 `(repo_origin, host, branch)` で active な他 session が 1 つでもあれば conflict。

### 8.2 advisory 内容

```jsonc
{
  "branch_conflict": true,
  "recommend_worktree": true,
  "worktree_command": "git worktree add ../<repo>-sess-<short_id> <branch>",
  "active_peer_count": 1,
  "active_peer_ids": ["<id>"]
}
```

### 8.3 lock しない

worktree は AI に注入される **提案** であり、 ユーザ / AI の判断で worktree 化するもしないも自由。 Concordia は強制しない (= lock 不要、 自律解決 を促す)。

---

## 9. provider 抽象 (multi-provider)

詳細: [`multi-provider.md`](../feature/multi-provider.md)。

`sessions.provider` 列で識別、 各 provider 個別実装は `src/providers/<name>.ts`。
v0.1 は Claude Code のみ。 Gemini / Codex は stub interface のみで NotImplemented を返す。

汎用 wrapper (`tools/concordia-hook.mjs`) は curl の薄ラッパで、 hook 機構を持たない CLI でも動く。

---

## 10. データ保管

- session_events は 90 日経過で auto-purge (sweeper が同時に削除)
- transcript path はパス参照のみ保持。 transcript の中身は Concordia 側に複写しない
- バックアップ: SQLite WAL のため `concordia.db` 単一ファイルをコピーするだけで OK
- 個人データルール準拠: `metadata` には認証 token や個人情報を入れない

---

## 11. バージョニング

| version | 対応 provider | 主機能 |
|---------|--------------|--------|
| 0.1 | claude-code | F1-F5 + F7 (Web monitor)、 LLM report は env で切り替え可 |
| 0.2 | + gemini-cli, codex-cli | F6 worktree 自動化 / LLM report 強化 / **F8 managed processes** |
| 0.3 | (multi-host)| Tailscale 越え、 multi-host 集約 |

---

## 12. F8 — managed processes (v0.2)

### 12.1 目的

dev-server / 監視ツール等の常駐プロセスを Concordia が直接 spawn して、
shell 監視 + 行ログのストリーミングまで肩代わりする. これにより:

- Claude Code は `Bash run_in_background` で個別管理しなくて済む
- 複数 session 間で同じプロセスを共有できる (重複起動を回避)
- ログは Concordia の eventBus / WS / SSE に乗るので統一購読できる

### 12.2 dev-process.md (定義の正本)

repo の cwd 直下に置く `dev-process.md` をプロセス定義の正本とする.
従来の人間向け自由記述 dev-process.md は **マーカーのみ** として温存され
(YAML/JSON フェンスが無ければ何も起動しない), 構造化フェンスがある場合のみ
auto-start の対象になる. フェンス言語は `concordia.processes`、 中身は JSON:

````markdown
```concordia.processes
{
  "processes": [
    { "name": "backend", "command": "npm run dev:backend" },
    { "name": "web",     "command": "npm run dev", "cwd": "web" }
  ]
}
```
````

各 process フィールド:

| キー | 型 | 既定 | 意味 |
|------|----|------|------|
| `name` | string | — | UNIQUE 識別子. `[a-zA-Z0-9_.-]{1,64}` |
| `command` | string | — | shell 行 (`shell: true` で spawn) |
| `cwd` | string | `"."` | dev-process.md からの相対 / 絶対 |
| `env` | object | `{}` | 追加 env (PATH 等は継承) |
| `auto_start` | bool | `true` | SessionStart 時に自動起動するか |
| `error_patterns` | string[] | `["error","panic","fatal","exception","uncaught"]` | level=error 判定の case-insensitive regex |

### 12.3 データモデル

```sql
CREATE TABLE processes (
  name         TEXT PRIMARY KEY,
  cwd          TEXT NOT NULL,
  command      TEXT NOT NULL,
  repo_path    TEXT,                              -- 紐付く repo
  repo_origin  TEXT,
  pid          INTEGER,                           -- 走行中のみ非 NULL
  status       TEXT NOT NULL,                     -- starting / running / exited / failed
  started_at   INTEGER,
  exited_at    INTEGER,
  exit_code    INTEGER,
  exit_signal  TEXT,
  log_path     TEXT NOT NULL,                     -- logs/<name>.log
  metadata     TEXT                               -- JSON (env / error_patterns)
);

CREATE TABLE process_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  process_name  TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  stream        TEXT NOT NULL,                    -- stdout / stderr / event
  level         TEXT,                             -- error / warn / info / NULL
  line          TEXT NOT NULL
);
```

### 12.4 API

| Method | Path | 用途 |
|--------|------|------|
| `GET`  | `/v1/processes` | 一覧 (`?status=` `?repo_path=`) |
| `POST` | `/v1/processes` | ad-hoc 起動 (dev-process.md に無い command も可) |
| `POST` | `/v1/processes/start-from-repo` | `{repo_path}` の dev-process.md 由来をまとめて起動 |
| `GET`  | `/v1/processes/:name` | 詳細 + 直近 50 行 |
| `POST` | `/v1/processes/:name/stop` | SIGTERM → 5s 後 SIGKILL fallback |
| `POST` | `/v1/processes/stop-all` | 走行中の全 (or `repo_path` 指定で絞った) managed processes を一括停止. PC リソース解放 / セッション終了時のクリーンアップ用 |
| `GET`  | `/v1/processes/:name/logs` | 過去ログ pull (`?since_ts=&level=&limit=`) |
| `GET`  | `/v1/processes/:name/stream` | SSE: そのプロセスの新規行のみ (backfill 100 行付き) |
| `DELETE` | `/v1/processes/:name` | 停止 + DB / log 行削除 |

### 12.5 eventBus (process.* 拡張)

`/ws` と `/v1/stream` には既存 wiring のまま流れる:

```ts
| { type: "process.started"; process_name: string; pid: number; cwd: string; command: string; ts }
| { type: "process.log";     process_name: string; stream: "stdout"|"stderr"|"event"; line: string; level?: "error"|"warn"|"info"; ts }
| { type: "process.exited";  process_name: string; exit_code: number|null; signal: string|null; ts }
```

### 12.6 Claude Code 連携 (パイプ二段)

1. **SessionStart additionalContext (一時的注入)**
   - `POST /v1/sessions` の response に `processes: { started, skipped, failed, warnings }` と
     `process_stream_url: ws://127.0.0.1:11111/ws` を含める.
   - `concordia-hook.mjs` が start 時に `[concordia/processes] auto-started: ...` を stdout に出す.
2. **UserPromptSubmit (差分注入)**
   - 各 prompt のたびに自分の repo に紐づくプロセスの「前回 cursor 以降の error 行」を
     `[Concordia process logs]` ブロックで stdout に追加. cursor は
     `~/.cache/concordia/proc-cursor-<sessionId>.json` に永続化, 二重貼りを防ぐ.

ログ全行が欲しい場合は AI が `/v1/processes/:name/stream` を Bash の Monitor で long-tail する.

### 12.7 ライフサイクル方針

- SessionStart 時、 同 repo に他 active session があり同じ name のプロセスが既に running
  なら **再起動しない** (= 共有). `skipped` に積んで AI に通知.
- session-end (DELETE) では止めない. 次 session が attach できる方が現実的なので、
  停止は明示 API or shutdown 時の `processManager.stopAll()` でのみ.
- `processes.failed` は `dev-process.md` 解析失敗 / spawn 直前のエラー / cwd 不在
  などのみ. spawn 後の異常終了は `process.exited` event + `status=failed` で表現.

### 12.8 既存 skill との関係

`error-watch` / `ewatch` skill は廃止せず温存. AI が `tail -F + grep` の手動ループを
回す古典経路と、 Concordia 経由の管理経路は併存する (用途が違うので潰さない).
