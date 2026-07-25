# Forum auto-spawn races an explicit Discord spawn

- Date: 2026-07-25
- Status: recurrence fixed in working tree; awaiting merge and live verification
- Area: Discord Forum ThreadCreate auto-spawn and `/spawn`
- Severity: high -- one user action can start an unintended second agent with an injected task

## Initial evidence

- 08:05:41 JST: explicit `/spawn` launched `lictor codex --model gpt-5.6-sol`.
- 08:05:45 JST: the same user flow launched `lictor claude --model claude-sonnet-5 --effort high`.
- The Claude session belonged to `forum-claude-session`, triggered by
  `discord-forum:1136199339417534606:1530350297547804802`.

## Ineffective first fix

PR #392 recorded `interaction.channelId` in a five-second in-memory map and made ThreadCreate
wait one second before checking the marker. This did not change the live behavior:

- `/spawn` runs in the interaction channel, while Cc creates a separate Session Forum thread.
  The interaction channel ID and the generated thread ID are therefore not the same correlation key.
- Process-local TTL state cannot identify a separately created Discord resource and remains timing-dependent.
- The fallback content guard expected `**Repository**`, but `buildForumStarterContent` emits `**Repo**`.
  Cc's own starter was consequently treated as a user request.

## Recurrence evidence

- 2026-07-25 09:05 JST: delegation run
  `54a4c5ad-1acb-4c6b-afa7-20bbfb0f9f84` launched `forum-claude-session`.
- Its trigger was
  `discord-forum:1136199339417534606:1530365291228303451`.
- It spawned PID `18272` and child session
  `lictor-f9c952e5-c6d2-4ca0-b68f-ff238a83946c`.
- The injected Forum content was Cc's own starter:
  `**Session** lictor-cf8b...` followed by `**Repo** Ars — E:\Document\Ars`.

## Root cause

The explicit `/spawn` route and Forum ThreadCreate route had no durable shared marker.
ThreadCreate also selected a fixed interactive provider plan from rate-limit availability rather
than classifying the post through the intended non-interactive `claude -p` selector.

## Resolution

- Add required Forum tag `Cc管理` (tag budget: work 5 + state 3 + system 1 +
  template maximum 10 = 19, within Discord's limit of 20).
- Session and TaskWorkflow thread creation applies the state tag and `Cc管理` in the same create
  request, so ThreadCreate can reject Cc-owned surfaces before authorization, starter fetch,
  template selection, or delegation invocation.
- Explicit `/spawn` inside a Session Forum thread persists the same tag before calling the spawn
  API. Failure to fetch/apply the tag is fail-closed.
- Forum auto-spawn checks the event tag state immediately and fetches fresh thread/parent tag state
  again immediately before invoke, allowing an explicit `/spawn` to win without a timer.
- Remove PR #392's in-memory TTL marker and one-second wait.
- Keep the content guard as defense in depth and recognize both `**Repo**` and `**Repository**`.
- Normal user-created Forum posts select exactly one active `forum_tag` template through one-shot
  `claude -p --model sonnet`. Invalid output, unavailable templates, and runner failure are
  fail-closed. The selected template is invoked without runtime overrides, preserving its provider,
  model, effort/options, and default arguments.

## Verification

- Focused suite: 7 files / 33 tests passed.
- Related Discord suite: 39 files / 206 tests passed.
- Full suite: 265 files / 1781 tests passed.
- TypeScript: `tsc -p tsconfig.json --noEmit` passed.
- Production build (backend TypeScript + Web Vite) passed.
- Tests cover atomic two-tag creation, config/API tag synchronization, early and fresh tag guards,
  `/spawn` tag-before-API behavior, no delegation selector in `/spawn`, Sonnet one-shot selection,
  invalid/failed selector output, and normal Forum invocation.
- Live verification after merge/restart: create a Forum thread, run `/spawn
  template:codex-5-6-sol`, and confirm no `forum-claude-session` run is created for either the
  interaction channel or Cc-generated Session thread.
