# Concordia

LUDIARS の **複数 AI コーディングエージェントセッション間の協調 / 認識 / 記録** サービス。

ラテン語で **同心 / 一致 / 協調** を意味し、 ローマ女神 Concordia (元老院・市民の和合の象徴) に由来する。
**lock せず**、 各セッションが自律的に状態を共有することで重複作業や知識の分断を防ぐ。

---

## セットアップ

設定・起動手順は用途別に [`spec/setup/`](spec/setup/) にまとめてある:

- [本体を起動する](spec/setup/core.md) / [Windows で起動する](spec/setup/windows.md) / [Discord bot](spec/setup/discord.md) / [observability](spec/setup/observability.md) / [セッション管制 spawn](spec/setup/spawn.md)
- 全設定キー: [spec/setup/config-reference.md](spec/setup/config-reference.md)

---

## 解決する課題

複数の AI コーディングエージェント (Claude Code / Gemini CLI / Codex CLI など)
を並行して使うとき、 以下が起きる:

1. **同じ repo を複数セッションで触っていて、 互いの作業を知らない**
2. **片方のセッションが落ちた**ことに気付かず、 残作業が宙に浮く
3. **セッション終了時のレポート**が手作業で大変
4. **どのセッションが今動いているか**が見えない

Concordia は repo・session・event を 1 つの SQLite に集約し、 各エージェントの hook
から HTTP で報告させることで、 これらを解決する。

---

## アーキテクチャ概観

```
┌──────────────────┐     hooks (HTTP)    ┌────────────────────────┐
│ Claude Code      ├────────────────────►│ Concordia (HTTP/Hono)  │
│ session          │  POST /v1/sessions  │  - sessions table      │
└──────────────────┘  POST /v1/.../event │  - session_events      │
┌──────────────────┐                     │  - session_reports     │
│ Gemini CLI       ├────────────────────►│  - background sweeper  │
│ (v0.2)           │                     │    (heartbeat→lost)    │
└──────────────────┘                     │  - jsonl recovery      │
┌──────────────────┐                     │  - worktree manager    │
│ Codex CLI        ├────────────────────►│                        │
│ (v0.2)           │                     │  Backend: SQLite (WAL) │
└──────────────────┘                     │  Port: 17330 (loopback)│
┌──────────────────┐                     │                        │
│ Web monitor      ├────────────────────►│  Frontend: Vite+React+ │
│ (Foundation UI)  │  GET /v1/monitor    │  Foundation UI         │
└──────────────────┘  GET /v1/sessions   └────────────────────────┘
```

## 主機能

| 機能 | 詳細 | 関連エンドポイント |
|------|------|-------------------|
| **F1. セッション登録** | start hook で repo/host/cwd/branch を登録、 同 repo の他 active session 一覧と lost candidates を返す | `POST /v1/sessions` |
| **F2. 進捗共有** | UserPromptSubmit / PostToolUse / PreCompact で current_task と event を蓄積 | `POST /v1/sessions/:id/event`, `PATCH /v1/sessions/:id` |
| **F3. 終了レポート** | Stop hook で蓄積 events から (a) **LLM サマライズ** と (b) **構造化集計** (event count / file diff / TodoWrite 完遂率) を両方生成 | `DELETE /v1/sessions/:id`, `GET /v1/reports/:session_id` |
| **F4. ロスト検知 + jsonl 復元** | 5 分間 heartbeat 無し → `status=lost`、 `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` を読みに行き、 最後の tool_use / response を構造化抽出 | sweeper + jsonl reader |
| **F5. ロスト引継ぎ** | SessionStart 時に lost candidate を提示、 引き継ぐ場合は前 session の current_task を継承 | `POST /v1/sessions/:id/resume` |
| **F6. 並列 worktree 自動化** | 同 repo + 同 branch で active session 検出 → SessionStart の `additionalContext` で **`git worktree add` 指示**を AI に注入 (lock はしない、 自律解決を促すだけ) | worktree manager |
| **F7. Web monitor** | 全 repo / 全 host の active session を一覧、 詳細 timeline、 report markdown プレビュー | frontend |

## 設計指針

- **lock しない**: 並行作業を前提とする。 worktree 自動化は提案のみ、 強制しない (lock より自由度を優先)
- **provider 中立**: `sessions.provider` 列で agent 種別を識別、 v0.1 は Claude Code のみ実装、 Gemini / Codex は stub
- **個人データ非保管**: session 内容は session_events に蓄積し 90 日で GC、 transcript path はパス参照のみ保持 (本体コピーしない)
- **ローカル運用**: loopback (127.0.0.1) bind、 認証なし。 tailnet 越え対応は将来 (`tailscale serve` 同様)
- **LUDIARS スタック準拠**: TypeScript + Node 22 + Hono + better-sqlite3 + Drizzle (or 直 SQL)、 frontend は React 19 + Vite + Foundation UI

---

## 多 provider 対応

各 AI コーディングエージェントごとに以下が異なる:

| | Claude Code | Gemini CLI | Codex CLI |
|---|------------|-----------|-----------|
| session_id | `$CLAUDE_SESSION_ID` env (built-in) | TBD (v0.2) | TBD (v0.2) |
| transcript | `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` | TBD | TBD |
| hook 機構 | `~/.claude/settings.json` の `hooks` (公式サポート) | (調査要) | (調査要) |

実装は `src/providers/<name>.ts` に分離し、 `AgentProvider` interface に揃える。
hook を持たない CLI 用に、 `tools/concordia-hook.mjs` の汎用 wrapper script
(任意の event を curl-like に送る) を同梱する。

詳細は [`spec/multi-provider.md`](spec/multi-provider.md) 参照。

---

## セットアップ (v0.1, Claude Code)

### 1. インストール

```bash
git clone https://github.com/LUDIARS/Concordia.git
cd Concordia
npm install
```

### 2. 起動

```bash
npm run dev          # Hono backend + Vite frontend を同時起動 (port 17330 / 17331)
npm run build        # production build
```

### 3. Claude Code の hook 設定

`~/.claude/settings.json` の `hooks` に以下を追加 (詳細は
[`docs/hooks-claude-code.md`](docs/hooks-claude-code.md)):

```jsonc
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/Concordia/tools/concordia-hook.mjs session-start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/Concordia/tools/concordia-hook.mjs prompt" }] }],
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command",
      "command": "node /path/to/Concordia/tools/concordia-hook.mjs edit" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/Concordia/tools/concordia-hook.mjs compact" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/Concordia/tools/concordia-hook.mjs session-end" }] }]
  }
}
```

### 4. Web monitor

ブラウザで `http://127.0.0.1:17331/` を開く。 全 active session の一覧 + 詳細 timeline + report が見える。

---

## MCP サーバ

Concordia は 3 本の stdio MCP サーバを同梱している。 別 AI session (Claude Code /
Codex / Gemini) から MCP 経由で Concordia 状態を直接読み書き / 操作できる。

| Server | dist path | Tools | 用途 |
|--------|-----------|-------|------|
| `concordia-core` | `dist/mcp/core-server.js` | 8 (sessions / stat / chat / conflicts / pending-tasks) | 横断状態の読み書き |
| `concordia-delegation` | `dist/mcp/delegation-server.js` | 2 (`delegation_list_templates` / `delegation_invoke`) | 委託テンプレ呼出 (Codex / Claude / Gemini spawn) |
| `concordia-vestigium` | `dist/mcp/vestigium-server.js` | 4 (`vestigium_list_services` / `_tail` / `_search` / `_recent_errors`) | LUDIARS 各サービスログ参照 |

Claude Code の `.claude/mcp_servers.json` に登録する例 (3 本まとめて):

```jsonc
{
  "mcpServers": {
    "concordia-core": {
      "command": "node",
      "args": ["E:/Document/Ars/Concordia/dist/mcp/core-server.js"],
      "env": { "CONCORDIA_BASE_URL": "http://127.0.0.1:17330" }
    },
    "concordia-delegation": {
      "command": "node",
      "args": ["E:/Document/Ars/Concordia/dist/mcp/delegation-server.js"],
      "env": {
        "CONCORDIA_BASE_URL": "http://127.0.0.1:17330",
        "CONCORDIA_SPAWN_TOKEN_PATH": "E:/Document/Ars/Concordia/.spawn.token"
      }
    },
    "concordia-vestigium": {
      "command": "node",
      "args": ["E:/Document/Ars/Concordia/dist/mcp/vestigium-server.js"]
    }
  }
}
```

`concordia-core` は Concordia HTTP loopback (default `127.0.0.1:17330`) を直接叩く
だけなので、 Concordia backend が起動している限り読み書き共に動作する。 認証は
loopback bind に依存する (= 非 localhost からは呼べない)。

`concordia-core` の 8 tools:

- `concordia_list_sessions` — sessions 一覧 (status / provider / repo_origin / host で絞り込み)
- `concordia_get_session` — 1 session の詳細 (session row + persona + 直近 events)
- `concordia_get_session_stat` — 指定 session の latest stat + 履歴 50 件
- `concordia_list_all_stats` — 全 session の latest stat (フラットチーム閲覧)
- `concordia_get_pending_tasks` — 指定 session の未配信 pending task
- `concordia_get_conflicts` — (repo, branch) の競合チェック
- `concordia_post_chat` — chat 投稿 (channel / author_label / scope / in_reply_to 対応)
- `concordia_recent_chat` — 直近 chat 一覧 (channel / since_ts / limit で絞り込み)

---

## 開発ステータス

**v0.1 scaffold (2026-05-02)** — 着手中。

| Phase | 内容 |
|-------|------|
| **v0.1** | Claude Code provider only / 基本 API / Web monitor / hook wrapper / lost 検知 + jsonl recovery |
| **v0.2** | Gemini CLI provider, Codex CLI provider, worktree 自動化、 LLM report generation (Anthropic SDK) |
| **v0.3** | Tailscale 越え (loopback → tailnet)、 multi-host 集約、 session lock オプション |

---

## ライセンス

MIT
