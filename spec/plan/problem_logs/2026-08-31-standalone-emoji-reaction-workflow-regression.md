# Standalone Emoji No Longer Starts Reaction Workflow

- Date: 2026-08-31
- Status: fixed in working tree
- Area: Discord / Slack reaction-workflow ingress
- Severity: medium — a documented shorthand command is silently treated as an ordinary message

## Summary

The user reported a regression where posting a mapped emoji by itself no longer starts Reaction Workflow. The documented behavior is that a standalone mapped emoji in a session surface acts like a reaction on the preceding message.

## Evidence

- User report received on 2026-08-31 JST: standalone emoji posting no longer starts Reaction Workflow.
- `src/discord/ingress.ts::tryEmojiWorkflow` returned `false` when `resolveEmojiTargetChatId` could not find a `chat_messages` row.
- `src/slack/bot.ts` had the same behavior when `getLatestWorkflowTargetForSession` returned `null`.
- The ordinary reaction handlers already obtain session context without requiring `chat_messages`, leaving standalone ingress on an older, stricter contract.
- No matching runtime diagnostic line was available in the repository log archive during investigation.

## Regression Context

Reaction Workflow was changed so platform reaction events no longer depend on message-map/database reversal, but standalone emoji ingress retained that dependency. A session can have live transcript relay context without a recent `chat_messages` row.

## Cause

Standalone emoji ingress incorrectly treated the optional previous-message snapshot as a prerequisite for dispatch. When the snapshot was absent, Discord fell through to normal inject and Slack fell through to normal message routing instead of starting Reaction Workflow.

## Fix Requirements

- Start a mapped standalone emoji from a registered session surface even when no previous `chat_messages` row exists.
- Use the previous row as optional message context when available.
- Keep Reaction Workflow disabled outside session surfaces.
- Keep the existing acceptance/result report format and do not add action buttons.

## Verification

- Regression coverage must assert that a Discord session thread dispatches a standalone mapped emoji with an empty optional target.
- Coverage must assert that legacy/non-session channels do not dispatch Reaction Workflow.
- Existing unit, integration, and service tests were not run because the session policy requires explicit user authorization.

## Follow-up

After merge, the dist build and Concordia service restart are needed through the normal Excubitor-controlled deployment path. No restart or live reaction test was performed in this session.
