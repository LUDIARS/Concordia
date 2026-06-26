# Claude Code hook integration

Claude Code の `~/.claude/settings.json` に追加する `hooks` 設定例。
Concordia の `tools/concordia-hook.mjs` を経由して HTTP API を叩く。

## 前提

- Concordia backend が `http://127.0.0.1:11111` で稼働中
- `node` が PATH に存在
- Claude Code の hook 機構 (公式) を理解している

## 設定例

`~/.claude/settings.json` または project 単位の `.claude/settings.local.json`:

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/Concordia/tools/concordia-hook.mjs session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/Concordia/tools/concordia-hook.mjs prompt"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/Concordia/tools/concordia-hook.mjs edit"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/Concordia/tools/concordia-hook.mjs compact"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/Concordia/tools/concordia-hook.mjs session-end"
          }
        ]
      }
    ]
  }
}
```

## 動作

- **SessionStart**: `POST /v1/sessions` → response の `advisory` を `additionalContext` として stdout に出す
  (Claude Code が AI に追加で渡す機構)
- **UserPromptSubmit**: `POST /v1/sessions/:id/event { kind: "prompt" }` (heartbeat 兼ねる)
- **PostToolUse (Edit/Write/MultiEdit)**: `POST /v1/sessions/:id/event { kind: "edit", payload: { file } }`
- **PreCompact**: `POST /v1/sessions/:id/event { kind: "compact" }`
- **Stop**: `DELETE /v1/sessions/:id` → 蓄積 events から report 生成、 概要を stdout に

## hook 失敗時の挙動

`concordia-hook.mjs` は Concordia backend が応答しない / 起動していない場合でも
exit 0 で抜ける (Claude Code 側の動作を阻害しない)。 ログは stderr に出る。

## 環境変数 (任意)

| key | default | 用途 |
|-----|--------|------|
| `CONCORDIA_URL` | `http://127.0.0.1:11111` | backend URL override |
| `CONCORDIA_PROVIDER` | `claude-code` | provider 名 (任意 agent 用) |
| `CONCORDIA_DISABLE` | (unset) | `1` で hook を no-op 化 |
| `CONCORDIA_TIMEOUT_MS` | `1500` | HTTP timeout (Claude Code を待たせない) |
