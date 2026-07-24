# Forum auto-spawn races an explicit Discord spawn

- Date: 2026-07-25
- Status: fixed in working tree
- Area: Discord Forum ThreadCreate auto-spawn and `/spawn`
- Severity: high -- one user action can start an unintended second agent with an injected task

## Evidence

- 08:05:41 JST: explicit `/spawn` launched `lictor codex --model gpt-5.6-sol`.
- 08:05:45 JST: the same Forum thread launched `lictor claude --model claude-sonnet-5 --effort high`.
- The Claude session belongs to `forum-claude-session`, triggered by `discord-forum:1136199339417534606:1530350297547804802`.
- `src/discord/forum-spawn.ts` starts an injected delegation from ThreadCreate; it does not use a non-interactive `claude -p` classifier.

## Cause

The explicit `/spawn` route and Forum ThreadCreate route were independent. A new Forum thread could therefore run both paths, and the Forum path chose an interactive Claude session by rate-limit availability.

## Resolution

- `/spawn` records a short per-thread suppression marker before calling the admin spawn route.
- ThreadCreate waits briefly for a concurrent explicit `/spawn`, then skips Forum auto-spawn when the marker exists.
- Existing Forum auto-spawn behavior remains unchanged when no explicit spawn occurs.

## Verification

- Unit test the suppression race and expiry.
- Reproduce with a new Forum thread and `codex-5-6-sol`; confirm no `forum-claude-session` delegation run is created for that thread.
