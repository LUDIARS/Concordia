---
type: feature
title: "Antigravity CLI (agy) のセッションにハーネスを効かせる"
service: concordia
domain: hook-transport
status: implemented
updated: 2026-11-21
---

# Antigravity CLI (agy) のセッションにハーネスを効かせる {#SPEC-AGY-HARNESS-HOOK}

> 所属ドメイン: [`hook-transport`](../domains/hook-transport.domain.json)

## 目的

agy のセッションには hook が配線されておらず、 ツール実行前のゲート (作業登録・ブランチ規則など) も
Concordia への観測 (指示・編集・ツール結果) も通っていなかった (2026-11-21 の点検: 監査記録 0 件)。
agy 自身の hook 機構に薄い変換を挟み、 Claude Code と同じハーネスを通す。

## agy の hook (1.5.13 の実機で確認)

- 設定: ユーザー共通 `~/.gemini/config/hooks.json`、 ワークスペース `<workspace>/.agents/hooks.json`。
- 書式: `{ "<名前>": { "<イベント>": [...] } }`。 `PreToolUse` / `PostToolUse` は
  `[{ "matcher": "<ツール名の正規表現>", "hooks": [{ "type": "command", "command": "...", "timeout": 秒 }] }]`、
  `SessionStart` / `PreInvocation` / `PostInvocation` / `Stop` は `[{ "type": "command", "command": "..." }]`。
- 入力 (stdin の JSON): `hookEventName` `conversationId` `cwd` `lastUserInput` `transcriptPath` `modelName`、
  ツールのイベントは `toolCall: { id, name, args }`、 `PostToolUse` は `error` も。
- `PreToolUse` の応答: 何も出さなければそのまま進む。 `{"decision":"deny","reason":"..."}` で止まり、
  理由がモデルに渡る。 `{}` は拒否、 未知の `decision` はエラーになるので出さない。
- ツール名は Claude Code と違う (`run_command` / `write_file` / `replace_file_content` など)。

## 変換 (`tools/agy-hook.mjs`)

| 呼び方 | agy のイベント | すること |
|---|---|---|
| `pre-tool` | `PreToolUse` | コマンド・編集のツールを Claude Code の形に写し、 ハーネスの supervisor に通す。 拒否なら `deny` を返す |
| `post-tool` | `PostToolUse` | ツールの結果 (失敗も) と編集を Concordia の観測 hook に渡す |
| `prompt` | `PreInvocation` | ターンの最初 (`invocationNum` 0) の人の指示を観測 hook に渡す |

- ゲートは Claude Code と同じ supervisor を使う。 場所は `CONCORDIA_HARNESS_RUNTIME` / `CONCORDIA_HARNESS_CONFIG`、
  または引数 `--runtime=` `--config=` (agy は Claude Code の settings.json の env を持たない)。
- 設定が欠けている・supervisor が異常終了した・入力が読めないときは、 通さずに止める。
- ゲートに掛けるのはコマンドと編集のツールだけ (`tools/agy-hook-mapping.mjs` の表)。 読み取りのツールは掛けない。
- セッションの対応付けは環境変数 (`LICTOR_SESSION_ID` / `CONCORDIA_SESSION_ID`) による。 Lictor を通さない agy は
  Concordia のセッションが無いので、 ゲートはセッションなしで判定され、 観測は送られない。

## 配置

`tools/agy-hooks.example.json` をワークスペースの `.agents/hooks.json` に置く。 置いた時点からその
ワークスペースの agy 全セッションに効くので、 `tools/agy-hook.mjs` が本体フォルダに入ってから置く。

## 範囲外

- ゲートの warn (注意だけで通す判定) を agy のモデルへ伝えること (`PreToolUse` に追記の応答が無い)。
- agy の transcript (`transcript_full.jsonl`) の取り込み。
