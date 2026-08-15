# Fable Discord tool-input relay was mistaken for thinking

- Date: 2026-08-13
- Status: fix implemented; **not deployed** — the live `dist` predates the merge (see the 2026-08-15 update)
- Area: Concordia Discord session-message egress
- Severity: user-visible chat and Discord noise

## Summary

The live Fable symptom is not a `thinking` relay recurrence. It is raw-looking JSON from Claude tool inputs (`Edit`, `Bash`, etc.) that Concordia persists as canonical `tool` session messages and posts unchanged to the Discord webhook. The merged default-OFF thinking implementation is present in `main`, and the live setting is currently OFF.

## Evidence

- Commit `2f6dd36d` (`fix(chat/cost): thinking中継を既定OFFにし、起動直後のctx誤計算を直す`) merged at 2026-08-13 13:56:13 JST.
- `session_messages` received 7 `author_type=thinking` rows and `transcript_logs` received 51 `kind=thinking` rows after that merge; the latest were at 2026-08-13 15:20:31 JST.
- The live Concordia listener was started at 2026-08-13 18:26:25 JST. Its settings API currently returns `session.thinking_messages_enabled=false` from the default source.
- No new thinking rows have been recorded after that process start.
- After a report that Fable was still showing `Thinking`, 46 Fable (`claude-fable-5`) sessions were checked after the current process start. They had zero `kind=thinking` transcript frames, zero `author_type=thinking` session messages, and zero assistant messages whose content contained `thinking`.
- The configured Fable Discord thread was read through the configured bot. Of its latest 100 messages, 48 were JSON-shaped tool inputs; no message contained the literal `thinking`.
- The three sampled Discord messages map through `session_message_delivery` to canonical `session_messages` with `author_type=tool` and labels `Edit` / `Bash`. The session had 384 delivered tool messages versus 23 assistant messages.
- The corresponding `transcript_logs` contain 1,284 `kind=raw` records, but those records are not projected to `session_messages` and are not the Discord posts. The visible JSON comes from `tool-use.input_preview`.

## Regression Context

Lictor intentionally produces normalized `thinking` frames for provider transcripts. Concordia commit `2f6dd36d` is responsible for dropping them from storage, WebUI, Discord, and Slack by default. `isThinkingEnabled()` is evaluated for every incoming frame, so changing the setting through the WebUI/API applies immediately and does not require a Concordia restart.

The 2026-08-07 Lictor commit `f08b638` (`feat(transcript): preserve all transcript content frames`) is a volume amplifier: it changed a Claude record from emitting only its first parsed frame to emitting every `text`, `tool-use`, `tool-result`, and `thinking` frame. It did not introduce tool-use frames themselves; the parent implementation already emitted the first `tool-use` frame. This makes it a plausible reason that multi-tool Fable turns became much noisier, but not the direct source of the JSON rendering.

Discord delivery of canonical `session.message` records itself began with Concordia commit `75c5c13` on 2026-08-11 23:24 JST. Therefore this exact Discord manifestation cannot have been visible on 2026-08-07; `f08b638` can only amplify the later-delivered volume.

## Cause

The historic `thinking` rows remain unattributable because neither the setting's prior value nor the process that served them is retained as durable evidence. The current Fable Discord noise has a separate confirmed cause: `tool-use` messages are deliberately projected and the Discord egress renders their JSON `input_preview` without a tool label or suppression. The thinking toggle cannot affect these messages.

## Fix Requirements

- Do not restart Concordia merely to toggle `session.thinking_messages_enabled`; set it through the WebUI/API and verify the returned effective value.
- Restart through Excubitor only when code or built `dist` changes must be loaded.
- Record setting changes and the running build/commit identifier so a later thinking recurrence can distinguish a temporary override from a stale process.
- Decide and implement the Discord policy for `tool` session messages: suppress them by default, or render a concise labeled summary rather than their JSON input preview.

## Verification

- Inspected the current compiled `dist/api/sessions/relay.js` and `dist/messages/service.js`; both suppress `thinking` when the setting is disabled.
- Read the live settings API: `session.thinking_messages_enabled` is `false` with source `default`.
- Confirmed zero new thinking rows in both transcript tables after the current process start.
- Read the live target Discord thread and correlated its JSON posts to `session_messages.author_type=tool` and their Discord delivery records. No test suite was run for this investigation.

## Implementation

- Normal `tool-use` entries now create a user-facing lifecycle record only (`実行中`); tool arguments remain outside that stream in the provider transcript / diagnostic relay.
- A matching `tool-result` updates that same record to `成功` or `失敗`, without storing or relaying its result body. Context hydration now restores normal tool mappings as well as Task mappings after a process restart.
- Discord skips the transient tool create event and posts the final `tool name: 成功/失敗` update. Tool and skill labels containing `Cc`, `Concordia`, or `LUDIARS` are rendered as inline code.
- Verified with 54 focused unit tests and full TypeScript type checking.

## 2026-08-15 Update — the fix is merged but not running, and `user` echoes were a second source

The 2026-08-13 implementation was merged, but the running compiled output predated that
merge and still projected raw tool arguments. No runtime setting gates the `tool`
projection, so a rebuild plus an Excubitor restart is required to load the merged
behaviour.

Operational audit also found `user` rows that were not Discord ingress. They originate
from transcript `text` frames with `role=user` and `session.inject` control paths, and
can contain terminal commands, harness bootstrap text, automated nudges, and echoed
instructions. This path was never covered by the 2026-08-13 fix.

`user` messages are now relayed only when they entered through an ingress Discord does
not already carry (`web` / `slack`). `discord` was already dropped as a self-echo;
`lictor` and a null platform are terminal input or automated injection and stay in the
WebUI record only.

## Follow-up

Add a durable audit trail for settings updates and expose the running build/commit identifier. This will make the next thinking recurrence attributable without inferring historic process state from current state.

Deploy the implementation, then verify it on a Fable session through Excubitor from the project main checkout under a Concordia testing claim.
