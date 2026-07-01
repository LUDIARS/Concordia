---
type: feature
title: "Concordia — Multi-Provider Spec"
description: "複数の AI コーディングエージェント (Claude Code / Gemini CLI / Codex CLI) を 1 つの Concordia インスタンスで扱うための AgentProvider 抽象レイヤーの仕様。v0.1 では claude-code が完全実装済み、gemini-cli / codex-cli は interface stub のみでトランスクリプトパーサ・hook 設定生成は v0.2 以降の予定。"
service: concordia
domain: analysis-core
tags:
  - typescript
  - llm
  - claude
  - codex
  - gemini
  - webhook
  - relay
  - lifecycle
status: wip
related:
  - ../setup/hooks-claude-code.md
updated: 2026-06-30
---


# Concordia — Multi-Provider Spec

複数の AI コーディングエージェント (Claude Code / Gemini CLI / Codex CLI など)
を 1 つの Concordia インスタンスで扱うための provider 抽象。

最終更新: 2026-05-02 / version: 0.1.0-draft

---

## 1. AgentProvider interface

```typescript
export interface AgentProvider {
  /** 識別子. DB の sessions.provider 列の値. */
  readonly name: string;

  /**
   * env / argv から session_id を解決する.
   * 不可なら null. (hook 側で agent 固有の env var をセットしておく前提)
   */
  resolveSessionId(env: Record<string, string>): string | null;

  /**
   * session_id + cwd から transcript file の絶対パス. ファイル未存在でも path だけ返す.
   * (jsonl recovery でファイル読み出し時に使う)
   */
  transcriptPath(sessionId: string, cwd: string): string | null;

  /**
   * transcript file の中身をパースして session_events 風の structured 形式に変換.
   * 主に lost session の最終状態を復元するために使う.
   */
  parseTranscript(content: string): RecoveryInfo;

  /**
   * (任意) hook 設定の生成. agent が hook 機構を持つ場合、 settings.json への
   * 追加例を返す. 持たなければ undefined.
   */
  generateHookConfig?(): unknown;
}

export interface RecoveryInfo {
  jsonl_lines: number;
  last_message_role: "user" | "assistant" | "tool_result" | "system";
  last_tool_use?: { tool: string; input: unknown; ts: number };
  last_text_summary?: string;
  todos?: Array<{ status: string; subject: string }>;
}
```

---

## 2. v0.1: claude-code provider

### 2.1 session_id

Claude Code は SessionStart hook の引数で `session_id` を渡す
(`hook_input.session_id` フィールド)。 hook wrapper script が
`CONCORDIA_SESSION_ID` env として export して以降の hook で利用。

### 2.2 transcript

- パス: `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`
  - encoded-cwd は cwd を `/` → `-` に変換したもの (例: `E--Document-Ars-Foo`)
- 形式: 1 行 1 JSON object (jsonl)
- 主要 type: `user` / `assistant` / `tool_use` / `tool_result` / `system`

### 2.3 parseTranscript の挙動

末尾から逆順に読み:
- 最後の `assistant` message → `last_text_summary` (text content の先頭 200 文字)
- 最後の `tool_use` → `last_tool_use`
- 最後の `TodoWrite` の content → `todos`
- 全行数を `jsonl_lines`

エラー (JSON 不正、 ファイル無し) は warn ログ + 部分的に取れた範囲だけ返す。

### 2.4 hook 設定

`~/.claude/settings.json` の `hooks` に以下を追加 (詳細は
[`setup/hooks-claude-code.md`](../setup/hooks-claude-code.md)):

```jsonc
{
  "hooks": {
    "SessionStart":     [/* concordia-hook.mjs session-start */],
    "UserPromptSubmit": [/* concordia-hook.mjs prompt */],
    "PostToolUse":      [/* concordia-hook.mjs edit (matcher: Edit|Write|MultiEdit) */],
    "PreCompact":       [/* concordia-hook.mjs compact */],
    "Stop":             [/* concordia-hook.mjs session-end */]
  }
}
```

---

## 3. v0.2 stub: gemini-cli

### 3.1 session_id

Gemini CLI の session 識別方法は調査中。 候補:
- env (`GEMINI_SESSION_ID` 等が公式に出るか)
- cli logs (`~/.config/gemini/...`)
- 起動時引数

### 3.2 transcript

調査中。 おそらく `~/.config/gemini/sessions/<id>/transcript.json` 系。

### 3.3 hook

Gemini CLI が hook 機構を持つかは未確認 (2026-05 時点)。 持たない場合は
`tools/concordia-hook.mjs` の wrapper を shell の wrapper / alias 経由で呼ぶ
代替方式を用意する。

v0.1 では interface stub のみ実装、 各メソッドは `throw new NotImplementedError()`。

---

## 4. v0.2 stub: codex-cli

### 4.1 session_id

Codex CLI (OpenAI) の hook / session 機構も調査中。 公式 docs を待つ。

### 4.2 transcript

調査中。 `~/.codex/...` 系を想定。

### 4.3 hook

Gemini CLI 同様、 v0.1 では stub のみ。 v0.2 で詰める。

---

## 5. 汎用 wrapper (any agent)

hook 機構を持たない / 公式 hook 提供前の agent にも対応するため、
`tools/concordia-hook.mjs` を汎用 HTTP client として同梱:

```bash
# 例: 任意の shell script から event を送る
node tools/concordia-hook.mjs event \
  --session-id="$MY_SESSION_ID" \
  --kind=prompt \
  --payload='{"summary":"refactor foo"}'
```

引数 / env で provider を指定できる:
```
CONCORDIA_PROVIDER=unknown node tools/concordia-hook.mjs ...
```

provider が `unknown` の場合、 transcript recovery は走らない (parseTranscript なし)。

---

## 6. v0.1 で実装する範囲

- ✅ `claude-code` provider 完全実装
- ✅ `gemini-cli` / `codex-cli` の interface stub (`name`, `resolveSessionId` のみ)
- ✅ `unknown` provider (汎用 wrapper 経由で event のみ受ける)
- ❌ Gemini / Codex transcript parser (v0.2)
- ❌ Gemini / Codex hook config 生成 (v0.2)

---

## 7. provider 別 sessions.provider 値一覧

| name | description | v0.1 status |
|------|-------------|-------------|
| `claude-code` | Anthropic Claude Code CLI | full |
| `gemini-cli` | Google Gemini CLI | stub |
| `codex-cli` | OpenAI Codex CLI | stub |
| `unknown` | hook 経路不明 / 汎用 wrapper | event のみ |

新 provider 追加手順は `spec/setup/contributing-provider.md` (将来) を参照。
