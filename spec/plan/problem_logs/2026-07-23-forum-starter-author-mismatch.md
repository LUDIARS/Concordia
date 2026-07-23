# Forum starter author mismatch breaks `session.started`

## Summary

When a Cc session starts from a user-created Discord Forum post, the
`session.started` handler attempts to edit the post's starter message. Discord
rejects the edit because that message was authored by the user, not by the bot or
Cc webhook.

## Observed evidence

At 2026-07-23 22:04:29 JST, `logs/concordia/cc-live.jsonl` recorded:

```text
[discord] session.started handler failed lictor-1279ed5a-26a9-4435-83ff-4428ebb49041: Cannot edit a message authored by another user
```

Equivalent failures are present for earlier Forum-spawned sessions.

## Root cause

The Forum-spawn branch in `src/discord/bot.ts` fetches the existing thread starter
and calls `updateForumSessionStarter`. That helper ultimately invokes
`message.edit(...)`. A bot cannot edit a message authored by a different Discord
user, so the handler exits before it stores a usable session surface message and
webhook binding.

This behavior was intentional in the older Forum migration specification, but is
invalid for a user-authored starter and is superseded by the requirements below.

## Required behavior

1. Never edit or replace a user-authored Forum starter. Preserve it as the user's
   task instruction.
2. For a Forum-spawned session, send a new metadata/status message in the same
   thread through the parent Forum webhook.
3. Persist that webhook message ID plus webhook ID/token as the session surface so
   later status changes edit the webhook-owned message.
4. Do not duplicate the starter body in a relay message when the original remains
   visible.
5. Webhook display name is a friendly model name plus a suitable stable identity
   (Delegation call name/current task/role fallback), respecting Discord's username
   length limit.
6. Webhook avatar uses the Delegation emoji image. Convert a Unicode emoji to a
   stable, pinned Twemoji-compatible PNG URL; strip variation selector `FE0F`, keep
   ZWJ sequences, and omit the avatar when no usable emoji exists.
7. Update the superseded Forum migration specification.

## Verification

- Unit tests prove a user starter is not edited.
- Unit tests prove the new message is sent through the webhook and its returned
  identity is stored for later edits.
- Tests cover display-name fallback/length handling and emoji-to-avatar URL
  conversion, including variation selectors and ZWJ.
- Existing bot-authored session-thread behavior remains valid.
- Type checking passes.

## Resolution

- The Forum-spawn binding now posts a separate status surface through the parent
  Forum webhook and stores its message ID plus webhook ID/token.
- The user-authored starter is neither fetched nor edited, and its body is no
  longer duplicated into a relay message.
- Lifecycle metadata updates use only `WebhookPool.editForSession`; missing or
  failed webhook ownership is reported instead of falling back to `message.edit`.
- Webhook display identity is derived as `<friendly model> · <stable identity>`.
  The Delegation emoji is converted to a pinned Twemoji PNG URL.
- Focused Discord tests: 43 passed.
- `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p tsconfig.test.json`: passed.
- Dependency Cruiser: no dependency violations.
