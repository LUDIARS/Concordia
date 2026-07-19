# Message Optimize OFF Still Hides Working Content

- Date: 2026-07-16
- Status: fixed
- Area: Discord transcript egress / message optimization
- Severity: medium — users cannot see live working updates even after explicitly disabling optimization

## Summary

At 2026-07-16 17:44:28 JST, the user reported that Cc behaved as if `message optimize` were enabled even though the checkbox was off. Codex final answers remained visible, but commentary containing the current working activity was suppressed.

## Evidence

- `src/discord/bot.ts` passes the resolved `env.messageOptimizationEnabled` value into Discord egress.
- `src/platform/transcript-relay.ts` unconditionally returned `null` for every text frame whose `phase` was not `final_answer`.
- Therefore `phase: "commentary"` was discarded before the optimization flag was evaluated.
- The existing test `drops Codex commentary for every chat adapter` encoded this unconditional behavior and had no OFF-state case.
- Reading the live config endpoint was attempted through the Excubitor catalog port, but the loopback request failed with `EADDRNOTAVAIL`; the user's observed OFF checkbox and the deterministic code path are the evidence for the setting state.

## Regression Context

Codex phase filtering was introduced to avoid noisy intermediate output, but it bypassed the explicit Discord setting. This made the OFF state semantically equivalent to ON for working updates.

## Cause

`extractRelayableTextFrame()` applied the Codex phase filter before and independently of `messageOptimizationEnabled`. It had no branch that relayed `commentary` when Discord explicitly disabled optimization.

## Fix Requirements

- Relay Codex `commentary` when Discord explicitly passes `messageOptimizationEnabled: false`.
- Continue suppressing commentary when optimization is ON.
- Preserve Slack's current default suppression when no Discord optimization option is supplied.
- Continue dropping unknown phases and non-human relay frames.
- Add unit and Discord egress regression tests for the OFF state.

## Verification

- Run the transcript relay and Discord egress tests.
- Run lint and build.
- After deployment, save the Discord setting with the checkbox OFF and verify commentary appears in the session thread while the fixed working indicator remains functional.

## Follow-up

Any live verification or Discord bot restart must use the Concordia project folder and Excubitor with testing claim/release.
