# Revisor #516 contract, plan-gate, and delegation review defects

- Date: 2026-08-13
- Status: fixed in review branch
- Area: Director plan gate / delegation continuation / team ownership / Discord authorization
- Severity: high — stale or unauthorized decisions could unblock work, and partial runs could advance taskflow early

## Summary

Revisor local PR #516 initially failed its registered `lint` case after `DirectorCase.session_id` became a required nullable field. Review then found runtime correctness defects in partial delegation, versioned plan decisions, team ownership propagation, and authorization of human acceptance actions.

## Evidence

- Revisor reported `1 registered test case(s) failed` for head `2db5ea960ee6744cdb8da8aa20370eebfc913a28`.
- `bootstrap`, `test`, and `build` passed.
- `lint` exited with code 2 in `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json && npm run depcruise`.
- TypeScript reported `TS2345` at `src/director/repo.test.ts:12`: the object passed to `DirectorRepo.createCase` was missing required property `session_id`.
- On the next reviewed head `87a4a91df14d212bcbbb6589f37ffa3eeaf66761`, `bootstrap`, `test`, and `build` passed, but `lint` failed in dependency-cruiser at `2026-08-13T09:37:03.555Z`.
- Dependency-cruiser reported `core-no-cost-write: src/control/phase-compaction.ts → src/cost/context-estimate.ts`.
- On reviewed head `78ce49edf593340bdfce3364513cb30c78e7d271`, the full test case passed, while both `lint` and `build` failed on the same `TS2339` at `src/discord/commands.ts:222`.
- TypeScript reported that `customId` did not exist on `never` in the plan-button branch.
- On reviewed head `980fa3b4f82d56fccb528264551e8c670a7f3469`, `bootstrap`, `lint`, and `build` passed. The test case failed only in `src/director/plan-gate.test.ts` with `acceptance criteria required`; 376 files and 2,646 other tests passed.
- After the registered gates passed on the next review, Revisor found that head `40446bcb5f8cc8a70ef62c5a3b0aff950181ba65` conflicted with current `main` `f9dc60f15ab7e3729d9c0e0c81b5e173395b2411` in six files.
- Current `main` had already shipped migration 62 (`delegation-staged-injection`), while the feature branch had independently assigned 62–65 to Director and Teams migrations.
- A partial status with residual work persisted the source run as completed and invoked taskflow completion before the replacement run finished.
- Plan action IDs and the action API omitted the submitted plan version, allowing an old Discord card to approve the newest plan silently.
- The revise action changed the plan step to active without delivering its instruction to the owning session.
- Explicit team selection reached an environment variable and prompt but was not persisted on delegation runs or sessions and therefore could not scope team harness rules.
- Discord plan actions and vibes `[OK]` acceptance were not included in the privileged interaction boundary even though they unblock implementation or PR submission.
- The partial continuation reader compared the source-tagged contract decision object to a string, so `in-session` was unreachable; its inject was also not persisted as a session event.
- The vibes scope predicate compared absolute edit paths to relative contract scopes lexically, so the default `scope_dirs: ["."]` denied every edit.
- Replacement runs created from partial reports or detached-question answers omitted the source run's canonical `team_id` and effective runtime selection, dropping team-specific rules and potentially changing provider/model/effort/fast mode mid-task.
- Partial requeue idempotency was sequential-only: concurrent status requests could both pass the source-status check before either marked it terminal and could launch two residual runs.
- Director approval, revision, and discard instructions were published only on the live event bus; the durable `contract` audit event did not contain the complete instruction text needed for later delivery.
- The merged checkout still assigned Director migration to version 62 and moved the already-applied staged-injection migration to 66, contradicting the forward-only migration requirement above.
- Vibes extension answers selected the first unreleased claim for a session rather than the service named by the answered question, so a multi-service session could renew or release the wrong service.
- The process-wide `team.created`/`team.changed` events were handled by subsidiary Discord bots as well as the head-office bot, which could disclose head-office team names and create their channel layout in unrelated guilds. Existing teams were also not reconciled after a bot restart.
- Contract question answers did not verify that the answered question belonged to the target session, and any non-`vibes` text silently fell back to `plan`.

## Cause

Migration 63 and the Director repository contract added `session_id: string | null` to `DirectorCase`. Production creation normalizes omitted API input to `null`, but the repository-level test constructs the persisted contract directly and therefore must supply the required nullable field.

The initial review fix only made that pre-existing fixture satisfy the type. It did not provide behavioral regression coverage for the new session lookup that plan actions rely on.

The phase boundary implementation also imported a cost-layer transcript reader directly from the control layer. That bypassed the repository's declared dependency direction even though the composition root can provide the same context percentage through an injected port.

The model-review custom-ID predicate declared a type guard to all `ButtonInteraction` values even though it recognizes only the `mreview:` subset. On the false branch, TypeScript therefore excluded every button interaction and narrowed the later plan-button branch to `never`.

The acceptance-section regular expression used multiline `$` immediately after the heading. That allowed the heading's line ending to satisfy the end alternative before any section body was consumed, so every otherwise valid acceptance section appeared empty.

The feature branch and current `main` both extended delegation composition, persistence, and persona context. Their independent migration sequences reused version 62, which cannot be resolved by editing the applied main migration.

Partial continuation reused the terminal `completed` state for queue-slot accounting but did not distinguish that bookkeeping state from semantic taskflow completion. Status retries also repeated the requeue side effect.

Plan decisions were associated only with a case, while the UI displays immutable versioned cards. Approval then looked up the latest decision instead of binding the action to the displayed version. Revision reused the implementation-active transition rather than the design-loop blocked transition.

Team selection had no canonical persistence path from spawn request through pending-spawn correlation and session registration. The new database ownership columns were otherwise orphaned.

Human acceptance interactions were added after the existing privileged-interaction classifier, so the default path treated them as ordinary conversation actions.

Two boundaries bypassed their typed representations: continuation did not use the contract parser, and vibes scope did not resolve contract-relative paths against the session repository root.

Residual requeue rebuilt an invocation from selected run fields but omitted the team runtime option. Its duplicate guard was a non-atomic read before an awaited spawn. Director callbacks likewise treated the live event bus as durable delivery even though disconnected sessions cannot receive it.

## Fix Requirements

- Add `session_id: null` to the pre-existing repository test fixture.
- Keep `DirectorCase.session_id` required so repository writes cannot silently omit the persisted field.
- Verify that `findLatestCaseForSession` returns the newest persisted case for the requested session, does not select a newer case owned by another session, and returns `null` for an unknown session.
- Keep transcript and cost estimation outside the control layer; inject only the context percentage needed for the phase decision.
- Cover both phase outcomes: compact at the threshold and durable handoff injection below it.
- Keep custom-ID subset predicates boolean; use Discord's structural `isButton()` guard for interaction type narrowing.
- Parse Markdown sections by heading lines, preserving lower-level headings and stopping at the next level-two heading without treating a line ending as the document end.
- Test missing and empty acceptance rejection, extracted content boundaries, and plan version increments.
- Preserve current main migration 62 byte-for-byte and append the feature migrations as versions 63–66 with new checksums and schema fingerprint.
- Preserve both team ownership and staged-injection fields in delegation persistence and prompt composition.
- Make partial status reporting idempotent, notify the parent, and suppress taskflow completion until the residual run itself completes.
- Bind every plan action to a positive plan version, reject superseded cards, keep revision blocked, and inject the requested revision into the owning session.
- Canonicalize team IDs at every spawn entry, persist them through delegation/pending-spawn/session rows, and select only global plus matching team harness rules.
- Require manager authorization for plan buttons/modals/text replies and vibes acceptance, failing closed when authorization is not wired.
- Preserve the selected team when a contract is seeded, and run contract-completion effects when a team answer resolves the final field.
- Read continuation through the typed contract parser and persist same-session continuation instructions before publishing them.
- Resolve vibes scopes as repository-relative paths, treating `.` as the root and rejecting absolute or parent-traversal scopes.
- Carry the source run's canonical team ID and effective provider/model/effort/fast-mode selection into every residual invocation.
- Claim partial requeue atomically before any task-store or spawn side effect, keep the claim counted against queue capacity, reject concurrent claims, and restore the source status when the side effect fails.
- Persist the complete Director instruction as `session_events(kind=inject)` before emitting it live.
- Bind each vibes extension answer to both its question session and named service.
- Provision and audit team Discord layouts only in the head-office guild, reuse IDs persisted for that team rather than same-name categories, and reconcile existing teams on bot startup.
- Bind contract answers to their owning session and accept only the explicit `plan`/`vibes` choices.

## Verification

- The fixture now satisfies the same `DirectorCase` contract used by `DirectorRepo.createCase`.
- A repository regression test covers session ownership persistence, newest-case selection, cross-session isolation, and the missing-session result.
- Phase compaction now receives context occupancy through its input contract, while the bootstrap composition root owns the cost-layer wiring.
- Phase tests exercise both sides of the configured threshold without transcript I/O.
- The model-review dispatcher now retains button interactions that do not use the `mreview:` prefix for later handlers.
- The plan-gate tests distinguish invalid inputs from valid multi-line acceptance content and verify two successive versions.
- The merged migration sequence applies through version 66 in memory, with main's staged-injection migration at 62 followed by Director and Teams migrations at 63–66.
- Persona-context coverage verifies that team rules remain present when staged injection selects the investigation posture.
- Partial-status regression coverage checks exactly one residual launch, no early taskflow completion, a durable parent notice, and idempotent retry handling.
- Plan tests cover stale-version rejection and verify that a revision remains blocked and reaches its callback; plan-card tests pin versioned custom IDs.
- Pending-spawn, contract-seeding, session ownership, and harness tests cover canonical team propagation and team-specific rule isolation.
- Discord dispatch and ingress tests verify that plan decisions and vibes acceptance fail closed without manager authorization.
- Continuation coverage includes both exactly-once requeue and typed `in-session` delivery; vibes coverage includes root scope, outside-root, and traversal cases.
- Concurrent partial-status coverage holds the first invoke open, requires the second request to receive `409 partial_requeue_in_progress`, and asserts a single residual run with preserved team ownership.
- Director instruction coverage asserts durable append happens before live publish and stores the complete text and source.
- The frozen migration ledger again pins main's unchanged staged-injection migration at 62 and assigns this PR's Director/Teams migrations to 63–66.
- The newly added phase-compaction fixture uses a generic repository path instead of adding a developer-local checkout path.
- Vibes lifecycle coverage keeps a second service claim untouched while extending the service named by the answered question.
- Team event handling is now head-office-only, and startup reconciliation uses the persisted team/category/surface IDs; an actual Discord guild still requires a runtime layout check.
- Contract-answer coverage rejects a question replayed against another session and rejects free text outside the typed `plan`/`vibes` choices.
- The added-line leakage scan reported no high-confidence credential, personal-path, private-endpoint, or transcript findings.
- Revisor must rerun the registered `lint` case on the updated head.
- No local test command was run in this session, in accordance with the session test policy.
