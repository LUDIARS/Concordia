---
type: setup
title: "Codex CLI worker"
description: "Concordia が Codex CLI セッションを `codex exec --json` 経由で追跡するワーカー。セッション登録・初期プロンプト記録・終了イベント収集と、JSONL ロールアウトからのトランスクリプト復元をサポートする。"
service: concordia
domain: tooling
tags:
  - codex
  - llm
  - spawn
  - relay
  - session-coordination
  - transcript
  - lifecycle
  - delegation
  - typescript
status: implemented
updated: 2026-06-30
---


# Codex CLI worker

Concordia can track Codex CLI sessions through `codex exec --json`.

## One-shot worker

この worker は明示的な手動 one-shot 用であり、Delegation の既定起動経路には使用しない。
Codex Delegation は Lictor の通常セッションとして起動し、App Server transport 経由で
prompt 投入と transcript 永続化を行う。

```bash
node tools/concordia-codex-worker.mjs --cd=/path/to/repo --model=gpt-5.5 "Fix the failing test"
```

The wrapper:

- runs `codex exec --json`
- waits for the `session_meta` event
- registers the session as `provider=codex-cli`
- records the initial prompt and final exit event
- prints the final assistant message to stdout

Useful environment variables:

| variable | default | purpose |
| --- | --- | --- |
| `CONCORDIA_URL` | `http://127.0.0.1:11111` | Concordia backend URL |
| `CODEX_BIN` | `codex` | Codex CLI executable |
| `CONCORDIA_TIMEOUT_MS` | `1500` | Concordia HTTP timeout |

## Transcript recovery

The `codex-cli` provider resolves transcripts by scanning:

```text
~/.codex/sessions/**/rollout-*.jsonl
```

It matches the `session_meta.payload.id` field and parses the JSONL for the
latest assistant text, tool call, and todo-like plan payloads.
