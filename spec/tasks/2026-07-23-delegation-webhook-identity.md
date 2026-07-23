# Delegation Discord webhook identity

Implement the fix and verification described in
`spec/plan/problem_logs/2026-07-23-forum-starter-author-mismatch.md`.

Keep Discord identity derivation, emoji avatar URL generation, and Forum-spawn
orchestration in focused modules. Avoid adding further responsibilities to
`discord/bot.ts`.

The public behavior is:

- user-authored Forum starter remains untouched;
- a new webhook-authored status surface is created in the same thread;
- webhook username is `<friendly model name> · <suitable identity>`;
- webhook avatar is the Delegation emoji image;
- subsequent lifecycle updates target that webhook message.
