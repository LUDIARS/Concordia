---
id: CC-SHARED-ONESHOT
status: draft
domain: governance
---

# Provider-neutral text generation

Value: UX-CC-W2/W5, scenarios UX-CC-S3/S6. Users must retain summaries and
recognizable task titles when one subscription has exhausted its allowance.

Governance is a supporting boundary. Lapilli owns pure model selection;
Cc owns quota acquisition, bounded CLI execution, cancellation and cost recording.
Report and title owners retain parsing, concurrency limits and publication state.

- CC-OS-01: Opt in daily narratives, report summaries and prompt titles only.
  Existing explicit-model, agentic, MCP and tool-bearing runClaude calls stay pinned.
- CC-OS-02: Pass fresh provider windows and model-specific windows to Lapilli.
  Unknown windows are unavailable; never convert unknown into a missing window.
  Weekly-only observations require the separate PR3349 quota-adapter fix.
- CC-OS-03: Launch once with no tools or MCP. Never replay on failure or ambiguous
  output. Preserve existing summary fallback and title parsing behavior.
- CC-OS-04: Record the actual provider/model, enforce cancellation and timeout,
  and remove owned output directories on every completion path.

Membership: src/rules adapter and paired tests belong to governance; daily
generator to observability; report generator to session-coordination; API assembly
to http-interface. No new persistent state is introduced.

Rollback: revert consumer imports and the Lapilli gitlink together. Do not replay
completed summaries. Runtime activation waits for PR3349 review clearance and
the normal review/deployment gates. The user approved tests on 2026-10-22. Registered focused regressions passed
(7 registered test files, 0 failures), run r-20261021222012395-31cbca0e.
Production and changed-test TypeScript checks passed. Runtime verification remains
unperformed. PR3349 merged as 9b86e47b2db3 and was incorporated before submission.
Post-integration verification: r-20261021223641919-9c070e19 (7/7 registered files passed).
