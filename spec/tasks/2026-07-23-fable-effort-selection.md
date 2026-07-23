# Fable delegation reasoning effort selection

## Goal

Make Fable delegation explicitly support `medium` and `xhigh` reasoning effort from
Cc's Delegation workflow, and prevent the capability from regressing.

## Current evidence

- `claude-fable-5-impl` and `design-hard-fable5` expose the `effort` runtime option.
- `provider-preset.ts` accepts `low`, `medium`, `high`, `xhigh`, and `max` for Claude.
- `resolveDelegationRuntimeArgs("claude", { effort })` emits
  `["--effort", effort]`.
- The Delegation UI renders runtime options from the template metadata and sends the
  selected option to the spawn endpoint.

The production path therefore already supports both requested values. Do not add
duplicate templates or special-case Fable unless a failing test demonstrates that
the generic path is insufficient.

## Required implementation

Add focused regression coverage proving all of the following:

1. Fable templates advertise both `medium` and `xhigh`.
2. A Fable spawn with `effort: "medium"` resolves to `--effort medium`.
3. A Fable spawn with `effort: "xhigh"` resolves to `--effort xhigh`.
4. The API/runtime option validation accepts those values and rejects unsupported
   values through the existing generic validation path.

If the focused tests uncover a real gap, make the smallest production change that
fixes it while retaining the shared provider-preset design.

## Acceptance

- Focused unit/API tests pass.
- Type checking passes.
- Existing Claude/Codex effort behavior remains unchanged.
