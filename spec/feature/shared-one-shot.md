# Shared one-shot launch boundary

UX-CC-W2/W5 and UX-CC-S2/S3/S6: preserve the original request, result and execution identity when a CLI fails or is stopped. Applies CC-INV-03/04/07 and CC-NODE-02/03/08.

The chores adapter, sprint-dialogues Claude adapter and delegation-provider worker use @ludiars/one-shot from the pinned lib/lapilli submodule (file dependency, Node >=22.12). This is a supporting process boundary for agent-delegation, not a new core domain. Lapilli owns model resolution, executable resolution and subscription-auth child environment. Cc owns request identity, prompts, permissions, deadlines, cancellation, output limits, persistence and terminal status. Parent worker metadata remains available; only the inference child's environment is cleaned. No retry, service control or permission bypass is added.

Chores retain Opus/medium and Luna/xhigh intent using shared roles. Explicit model identifiers remain explicit. Claude conversation calls keep tools/customizations disabled and Windows native executable ownership. Generic Claude and Codex calls explicitly resolve a shared default; telemetry records that resolved model.

Acceptance: existing cancellation and event tests remain registered; adapter tests check role overrides, effective model telemetry and conversation restrictions. Type checking and syntax checks are local; registered tests run in Revisor. Live CLI inference and service restart are not performed. Restore by reverting this change and the submodule pointer together; preserve execution records and reconcile unknown jobs rather than resubmitting.

Setup: git submodule update --init -- lib/lapilli, then npm ci. The library has no build step.

Local verification (2026-10-03): source typecheck passed after building the existing Vestigium dependency; worker node --check passed. Whole test typecheck remains blocked by pre-existing ProviderName errors in src/api/sessions/startup-policy-check.test.ts:50 and tests/usage-budget-spawn.test.ts:27. No local tests or live operations were run. Revisor retains bootstrap/test/lint/build registrations.

The supporting tooling domain owns the root Vitest configuration: exclude the vendored Lapilli suite while retaining Cc adapter tests and all existing default exclusions. The registered full Cc suite exercises this configuration; the library retains its separate test suite.
