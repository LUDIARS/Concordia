# Codex CLI worker

Concordia can track Codex CLI sessions through `codex exec --json`.

## One-shot worker

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
