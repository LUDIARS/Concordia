# Codex CLI hook integration

OpenAI Codex CLI (`codex`) の hook 機構を経由して Concordia backend の
HTTP API を叩く。 Claude Code 用の `concordia-hook.mjs` をそのまま使い
回せるよう、 payload 差 (`user_prompt` vs `prompt`, `file_path` vs
`command` 等) は hook 側で吸収する。

## 前提

- Concordia backend が `http://127.0.0.1:17330` で稼働中
- `node` が PATH に存在
- Codex CLI v0.x (`hooks.json` / `[hooks]` テーブル対応版) を使っている
  - 公式: <https://developers.openai.com/codex/hooks>

## 設定例

`~/.codex/hooks.json` (user 全体に効く):

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node E:/Document/Ars/Concordia/tools/concordia-hook.mjs session-start",
            "commandWindows": "node E:\\Document\\Ars\\Concordia\\tools\\concordia-hook.mjs session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node E:/Document/Ars/Concordia/tools/concordia-hook.mjs prompt"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "apply_patch|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node E:/Document/Ars/Concordia/tools/concordia-hook.mjs edit"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node E:/Document/Ars/Concordia/tools/concordia-hook.mjs compact"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node E:/Document/Ars/Concordia/tools/concordia-hook.mjs session-end"
          }
        ]
      }
    ]
  }
}
```

`config.toml` 派なら `[[hooks.UserPromptSubmit]]` 等のインラインテーブル
を使う (Codex 公式仕様参照)。

## 初回 trust

Codex CLI は user/project の hook を **trust 承認** してから初めて発火する.
最初に `codex` を立ち上げると `/hooks` でレビュー → trust する必要がある.

緊急で 1 回だけ回避したい場合は:

```sh
codex --dangerously-bypass-hook-trust
```

## Lictor 配下で使うときの session_id

[`concordia-hook.mjs`](../tools/concordia-hook.mjs) は session_id を以下の優先順で
解決する (`tools/concordia-hook-resolver.mjs`):

1. `CONCORDIA_SESSION_ID` env (Lictor が wrap 時に export する強い signal)
2. `ctx.session_id` (hook stdin の Codex 内部 UUID)
3. `CLAUDE_SESSION_ID` env (Claude Code 互換 fallback)

`lictor codex` で wrap 起動した場合は (1) が常に勝つので、 Codex 内部 UUID と
Lictor session ID の不一致による hook 沈黙バグ ([Concordia #35][pr35]) は
踏まない. 単独 `codex` 起動の場合は (2) が使われ、 session-start hook が
その ID で Concordia へ登録する.

[pr35]: https://github.com/LUDIARS/Concordia/pull/35

## Payload 差吸収

`concordia-hook.mjs` は Claude Code と Codex CLI の payload 差を 1 個の
script で吸収する (resolver は `tools/concordia-hook-resolver.mjs`):

| event | Claude payload | Codex payload | 吸収後 |
|-------|----------------|---------------|--------|
| prompt | `ctx.user_prompt` | `ctx.prompt` | `resolvePromptText(ctx)` |
| edit (PostToolUse) | `tool_input.file_path` / `.path` | `tool_input.command` (Bash), `tool_input.file_path` 等 (apply_patch) | `resolveEditTarget(ctx)` |
| compact | `kept_messages` | `trigger: "manual"\|"auto"` | 両方 payload に同梱 |

## hook 失敗時の挙動

`concordia-hook.mjs` は backend が応答しない場合でも exit 0 で抜ける.
Codex CLI 側は exit 0 + 空 stdout を「成功 (制御無し)」 と解釈するので
Codex の動作は一切阻害されない.

## 環境変数 (任意)

| key | default | 用途 |
|-----|--------|------|
| `CONCORDIA_URL` | `http://127.0.0.1:17330` | backend URL override |
| `CONCORDIA_PROVIDER` | `claude-code` | provider 名 (Codex 側で hooks.json から起動するなら `-c` で `CONCORDIA_PROVIDER=codex-cli` を渡すと session-start で正しい provider が記録される) |
| `CONCORDIA_DISABLE` | (unset) | `1` で hook を no-op 化 |
| `CONCORDIA_TIMEOUT_MS` | `1500` | HTTP timeout (Codex を待たせない) |
| `CONCORDIA_HOOK` | (unset) | `1` で「強制 opt-in」、 session-start を含む全 hook が active 判定を経ずに動く |

Lictor 配下で `provider="codex-cli"` を Concordia に記録したい場合は、
hook 設定 1 件ごとに env を分けるか、 wrapper script を 1 個噛ますのが
楽 (Lictor 自身は `lictor codex` で `provider=codex-cli` を Concordia 登録
時に渡しているので、 lictor 配下なら hook 経由の registration は通常
発火しない = この問題は単独 `codex` 起動時のみ意識すれば足りる).
