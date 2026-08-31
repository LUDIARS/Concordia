# OK-hand Reaction Triggered an Unrequested Handoff

- Date: 2026-08-31
- Status: fixed in working tree
- Area: reaction workflow / session prompt injection
- Severity: high — an acknowledgement reaction injected and executed an instruction the user did not issue

## Summary

An ordinary 👌 acknowledgement was classified as `handoff-document`. Concordia injected a generated handoff prompt as a generic `User` message, and the session obeyed it by creating a handoff document under the workspace session-log directory. The user explicitly confirmed that no handoff instruction had been given.

## Evidence

- The initiating follow-up had Discord provenance.
- The generated handoff prompt was then recorded as author `User` with `platform = null`, so the injected instruction was indistinguishable from a direct user instruction at the model boundary.
- A later user message with Discord provenance confirmed that no handoff was requested and directed the investigation to continue.
- `src/platform/reaction-workflow.ts` mapped both 👌 and 👋 to `handoff-document`.

## Regression Context

The reaction workflow exposed an operational ambiguity between a common acknowledgement gesture and an explicit lifecycle command. Existing classification coverage asserted that 👌 initiated a handoff, so it preserved the unsafe behavior instead of catching it.

## Cause

`WORKFLOW_EMOJI["handoff-document"]` included 👌. The generated prompt was then injected without platform or workflow provenance in the canonical session message, allowing it to be treated as an ordinary user instruction.

## Fix Requirements

- Remove 👌 from the default `handoff-document` triggers.
- Reserve 👌 as a permanently non-actionable emoji because a double-tap can send it accidentally; built-in mappings, configured overrides, and custom workflow JSON must not be able to assign it.
- Reject an external reaction-workflow plugin unless it preserves the same reserved-emoji invariant.
- Retain 👋 as the explicit handoff trigger.
- Cover both classifications with regression assertions.
- Keep this fix scoped to preventing the accidental trigger; provenance hardening should be tracked separately if pursued.

## Verification

- `classifyReactionWorkflow("👌")` must return `null`.
- An attempted configured override for 👌 must still classify to `null`, and a custom workflow JSON entry for 👌 must not execute.
- The reaction-mapping API must reject attempts to persist a 👌 override, and plugin compatibility checks must reject engines that make it actionable.
- The flattened built-in mapping must never contain 👌.
- `classifyReactionWorkflow("👋")` must continue to return `handoff-document`.
- Tests were added but not run, per the task constraint.

## Follow-up

The mistakenly created handoff document remains outside this repository under the workspace session-log directory. It was not deleted because deletion was not requested.
