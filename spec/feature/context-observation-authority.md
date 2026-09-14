---
id: CC-CONTEXT-OBSERVATION-AUTHORITY
title: Lictor-owned transcript identity and bounded context observation
status: draft
domain: observability
---

# Context observation

UX-CC-W4/W5, CC-INV-01 and CC-NODE-01/02: context indicators must use the session's actual log without blocking coordination or showing a guessed percentage.

## Ownership
Lictor owns provider transcript discovery and reports transcript_path. Concordia's stalled-session-nudge and sweeper do not invoke provider discovery when the path is absent. Missing binding remains unknown; no timestamp/cwd substitute is selected.

## Observation contract
`src/cost/context-observation-reader.ts` reads at most the last 1 MiB of the trusted provider log, discards incomplete JSONL boundary records, and caches the parsed result against file identity, size and timestamps (128 entries). Concurrent requests for a path share work. Missing files and measurements outside the bounded tail yield unknown. Recovery never triggers a whole-file retry.

`src/cost/context-observation.ts` owns the pure `contextObservationFromLines` policy: Codex last_token_usage.input_tokens (cache already included), with info.model_context_window from that observation. Claude assistant input plus both input-cache fields gives the last request input; sidechains are excluded. Compaction invalidates preceding observations. This is last-request input, not an exact live tokenizer count between requests.

`src/cost/context-estimate.ts` uses a provider window before an explicit caller/environment window. Without either, windowTokens and pct are null, while tokens remain available. The historical 200000 helper default is not a runtime observation default. Context badges, Discord reports and session cost summaries show unknown windows without calculating remaining capacity.

`src/cost/context-usage.ts` uses the same observation and does not label first-request input as fixed overhead or conversation-only growth. Legacy pure formatting helpers remain for compatibility.

## Verification and recovery
The reader's path resolver is an injectable I/O boundary, defaulting to the trusted production resolver. Reader tests pass their fixture resolver explicitly: the repository uses Vitest `isolate:false`, so module-level mocks can miss dependencies cached by earlier test files. No production trust check is disabled.

`src/cost/channel-cost-cache.ts` uses the same pure observation policy and never falls back to a full file for context. Its path cache and `src/cost/session-usage-cache.ts` invalidate on a changed provider or reported transcript_path, even when the old file still exists; otherwise /clear kept displaying the old session. The channel-cost-cache regression cases cover this rotation and missing-tail behavior.

Regression cases are in context-observation.test.ts. Tests are authored but not executed under the current user policy. Missing observations recover on the next bounded read after new provider usage is appended. Lictor path-report retry is a separate Lictor change; no service restart/deployment is performed by this PR.
