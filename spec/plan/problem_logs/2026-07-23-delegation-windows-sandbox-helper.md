# Delegation child sessions cannot initialize the Windows sandbox

## Summary

Three Cc `impl-from-design` Delegation runs launched successfully and registered a
child Lictor/Codex session, but every local command and file edit failed before the
task could read its design document. The failure is in Codex's Windows sandbox
setup helper, not in Concordia's template rendering, spawn registration, target
worktree, or task code.

## Affected runs

| Run | Child session | Effort |
| --- | --- | --- |
| `380c9e04-e1d5-43dd-a9dd-3623f0629a4c` | `lictor-9848dce0-2088-4b9f-b828-b5c7fed10881` | high |
| `16677fde-90b2-4f91-82f8-0c99098bea75` | `lictor-347c2f0c-c766-4ae9-9f62-2922e90c3274` | xhigh |
| `74cad9ee-2c42-48b5-9981-4c5ed73a78c2` | `lictor-a6fc34bc-ec3c-4ae6-a969-293fa1f657f4` | xhigh |

The parent marked all three runs `failed` after confirming that no delegated
repository change had been produced.

## Exact evidence

The Codex rollout for the Fable run records a minimal `Get-Location` failure:

```text
execution error: Io(Custom { kind: Other, error:
"windows sandbox: orchestrator_helper_exit_nonzero:
setup helper exited with status Some(1)" })
```

A retry with an explicit worktree reports:

```text
execution error: Io(Custom { kind: Other, error:
"windows sandbox: helper_unknown_error: setup refresh had errors" })
```

`apply_patch` also failed to create a one-line probe inside the configured writable
worktree:

```text
Failed to write file
E:\Document\Ars\.wt-Concordia-fable-reasoning\sandbox-probe.tmp
```

The same pre-command failure occurred independently in all three children. Their
turn context correctly listed the intended worktree as writable and used
`workspace-write` with `approval_policy=never`.

## Analysis

- Concordia successfully created each run, wrote the rendered prompt, launched
  Lictor/Codex, received session registration, and persisted transcript frames.
- The failing command was `Get-Location`, so repository contents, Node packages,
  git hooks, and the requested implementation cannot be causal.
- The worktrees are writable from the parent and later in-process parallel agents.
  The path and git-worktree layout are therefore not generally invalid.
- The common boundary is the Windows sandbox setup/refresh helper used by the
  independently launched Codex CLI children.

This confirms the incident but does not yet prove whether the underlying trigger
is concurrent CLI sandbox initialization, the `approval_policy=never` launch
profile, or a transient helper/ACL state. Disabling the sandbox is not an
acceptable workaround.

## Follow-up verification

1. Reproduce with one isolated Cc Codex Delegation run, not a batch.
2. Capture the helper's own diagnostic log/exit detail if Codex exposes it.
3. Compare the failing launch profile with a working Lictor-wrapped Codex session.
4. Test sequential launch and a short bounded retry of helper initialization.
5. Keep failed runs terminal; do not leave `running` rows linked to ended/lost
   child sessions.

