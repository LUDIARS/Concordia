# Revisor #381 clean-worktree dependency bootstrap failure

- Date: 2026-08-12
- Status: fixed in review branch
- Area: dependency bootstrap / Revisor registered tests
- Severity: high — clean review worktrees cannot establish the dependencies required to test a local PR

## Summary

This is a recurring clean-worktree regression. Revisor local PR #381 was retried from State0, but its registered tests failed before application verification because the review checkout did not have a complete, ordered dependency bootstrap.

## Evidence

- Revisor completed the retry at `2026-08-12T09:26:20.176Z` with `3 registered test case(s) failed`.
- The root `install` case timed out after `600575ms`.
- The subsequent `npm test` reported that `vitest` was not available; `npm run lint` likewise could not resolve `tsc`.
- In a new worktree, root dependency resolution also fails before installation when `lib/vestigium` has not been initialized. After initializing that submodule, its `prepare` path needs its own development dependencies before the root `file:lib/vestigium` dependency can be installed.
- Revisor local PR #496 bootstrapped successfully (`328827ms`), but its test case failed after `694967ms` on 2026-08-12. The two failures were timeouts in real-Git tests: `cleanupRepo (real git)` reached `120000ms`, and the delegation worktree test reached `15000ms`.

## Regression Context

The registered Revisor cases expose setup as several independent shell commands. A preceding install failure therefore leaves later test and lint cases without their executables, producing misleading secondary failures. Cernere has already adopted a single ordered bootstrap command for the same Vestigium submodule pattern.

## Cause

Concordia has no repository-owned bootstrap command that guarantees submodule initialization, a Vestigium build, and development dependency installation in a clean worktree. The CI workflow and Revisor registration duplicate parts of that sequence instead of invoking one authoritative entry point.

The bootstrap exposed a separate blocking regression in current `main`: two migrations used version 60. Every test that created a database then failed before its assertions ran. The later `taskflow-task-state-slug` migration must be assigned a fresh version and both shipped migrations must be present in the frozen ledger.

Once migrations could run, typecheck found the API test factory no longer supplied the newly required `taskflowState` dependency. The factory must construct and pass the same state store as the application bootstrap so API tests continue to model a valid application.

The full suite also revealed that the duplicate-slug test created its second document through rename-aware migration, which deliberately rekeys the sole matching row instead of producing an ambiguous pair. The test now seeds two persisted rows explicitly so it verifies the intended no-guess branch. The remaining Claude log fixture needs its existing user-home write permission in this sandboxed environment.

The #496 failures are a test-harness regression under a loaded Revisor Windows worker, not failed cleanup or worktree behavior: both tests use isolated temporary repositories and each production `ws-cleanup` Git invocation remains bounded to 30 seconds. Their aggregate test budgets were too short for the intentionally multi-command real-Git flows.

## Fix Requirements

- Provide one bootstrap command for a clean clone or worktree.
- Initialize submodules, install Vestigium development dependencies without running its prepare hook, then build Vestigium before installing root dependencies.
- Always include development dependencies, including when `NODE_ENV=production` is set.
- Install web dependencies so `npm run build` works after bootstrap.
- Make CI and Revisor use the same bootstrap command before test and lint.
- Assign the later task-state slug migration version 61 without modifying the deployed version 60 migration, and freeze both migrations in the ledger.
- Give the API test factory a `TaskflowStateStore` and pass it to both the task document store and application dependencies.
- Keep the two real-Git tests bounded but give their aggregate operations sufficient review-worker time; retain the per-command 30-second production Git bound.
- Give Revisor's full Concordia test case a 30-minute outer timeout so the already bounded suite is not killed during a loaded review.

## Verification

- `NODE_ENV=production npm run bootstrap` completed in a new task worktree.
- `npm run lint` completed successfully.
- `npm test` completed successfully: 366 files / 2,615 tests.
- `npm run build` completed successfully.
- Revisor registration now runs `bootstrap`, `test`, `lint`, and `build` in that order.
- `npm test -- src/control/ws-cleanup.test.ts src/delegation/service.test.ts` completed successfully: 47 tests. The two real-Git tests took 108.3 seconds and 9.3 seconds respectively under local load.
- Requeue Revisor #381 only after its branch contains the bootstrap fix and the registered test setup has been updated.

## Follow-up

The original #381 branch is behind current `main` and has unrelated uncommitted worktree content. Do not overwrite it; rebase or reapply its functional change after this bootstrap prerequisite is merged.
