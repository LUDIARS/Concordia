---
title: LUDIARS design review handoff — review and first implementation
id: CC-DESIGN-REVIEW-RESUME-REVIEW
type: plan
status: proposed
service: concordia
domain: tooling
updated: 2026-10-16
---

# Review of Concordia GitHub PR #3

Reviewed source: `984a4b1a2d0821971e7b4910a08dbc3d64378d5c`, based on Concordia
`40df07376fc7b6363d1701c01595eec0e7affee2`. This task uses a separate worktree
created from local main. The original nine files are preserved in its history;
the GitHub PR has not been edited, approved, merged, or duplicated on GitHub.

Instruction: neco, “これ読んでレビューして実装”. Actio reference:
`actio:eb630c9f-3614-42b0-a9a3-5568d994251e`. This is the first implementation
unit, not completion of the nine-service optimisation programme.

## Findings and changes

| ID | Severity | Evidence at reviewed revision | Resolution |
|---|---|---|---|
| HR-01 | medium | analyze.js and verify.js bind WF to a discarded session's `/tmp/.../scratchpad/wf`; all three Workflow scripts bind ROOT to `/home/user`. | Require `args.root` / `args.wf` before agent calls; accept drive-letter and POSIX absolute paths. |
| HR-02 | medium | make-digests.mjs accepts zero or only three maps, optional scouts, and silently defaults missing sections to empty arrays. No output identifies coverage. | Validate inputs before writes, refuse incomplete input by default, require `--allow-partial` for labelled partial output; keep real supplied maps as regression fixtures. |
| HR-03 | medium | understand/analyze use `filter(Boolean)` on provider output; unknown reader labels schedule no reader, invalid dimensions dereference undefined, and verify without batches returns an empty success. | Validate selectors and batches; fail on absent results, including either verification lens; return reader labels for preserving the two Cc readers. |
| HR-04 | medium | analyze d6 requires every candidate's implementNow.feasible to be true, while proposing mandatory environment variables, timeout changes and health endpoints under a behaviour-preserving rule. | Permit false and an empty findings list; explicitly distinguish behaviour changes from mechanical corrections. |
| HR-05 | low | Concordia spec/README.md describes four sections in frontmatter, six categories in prose, and omits current directories from its tree. | Remove obsolete counts and list the current directories; distinguish historical task documents from Actio state. |
| HR-06 | medium, process | Handoff §§5–7 assume old Workflow availability, direct GitHub push/PR creation and an old container's dependency failures. | Add a current-environment correction section. Use Revisor local PR; no inferred test, merge, restart, or model authorization. |

The renderer, input adapter and CLI output adapter are separated in
`tools/design-review/`. The historical digest entry delegates to the CLI adapter.
No source-service API, authentication, polling interval, timeout, or runtime
deployment configuration is changed by this unit.

## Spot checks of the original cross-service claims

These are targeted source checks, not the missing seven reader jobs or a complete
adversarial review. Sources were read from the local repositories; their runtime
behaviour was not tested.

| Claim | Current evidence / verdict | Consequence |
|---|---|---|
| Actio duplicate specRefs | Actio `3e18493`, spec/domains/web-frontend.domain.json has keys at lines 4 and 12. Confirmed. | Needs a separate Actio change merging both reference lists, not deleting either set blindly. |
| Actio push hook points at Schedula | Same revision, .claude/settings.json:9 still uses `/home/user/Schedula/scripts/ci-check.sh`. Confirmed. | Do not execute this hook or bypass review gates; investigate its current owner before changing it. |
| Actio authentication URL default | Same revision, frontend/src/pages/Dashboard.tsx:129 uses VITE_CERNERE_URL then localhost:8080. Confirmed code, operational impact unmeasured. | Changing a default changes behaviour and is not a mechanical cleanup. |
| Anatomia Cc address defaults | Anatomia `d4d68a2`, src/providers/concordia-cost.ts:22–27 uses CONCORDIA_URL then host/port defaults. Confirmed. | Requiring an env variable changes startup/reporting behaviour; design migration first. |
| Br serial Revisor calls | Breviarium `eff7060`, src/adapters/sources/revisor-source.ts:34–38 and 70–76 serialise repo list, PR list, up to five PR details and version show. 60s timeout is per call, not a measured latency. Comments explicitly cite opening Revisor's DB as the reason for one process at a time. | The bottleneck exists structurally, but blind parallelisation is not justified. Prefer an owner-provided batch read contract; verify database constraints and evidence equivalence first. |
| Toolchain differences | Current package.json: Augur >=20, Genius >=22, Conflux >=24; they have different entrypoints. Confirmed declarations only. | Version differences alone do not establish a defect; inspect used APIs before standardising. |
| Missing submodules prevent all validation | New worktree has uninitialised Lapilli/Vestigium, but main already has js-yaml and Vitest installed; current Node is v24.14.1, not the old v22.22.0. | Spec-index generation is possible with the existing dependency installation. Do not reuse old npm-ci failure as proof all checks are blocked. |
| Cc has 13 spec folders | This worktree has 12. | Treat old counts as historical measurements, not current acceptance criteria. |

Neither multiple project identifiers nor different test ledgers alone prove
duplicate ownership. Project lookup, workload identity, test execution and
requirement coverage have distinct lifecycles. A consolidation proposal needs
an owner, identity mapping, migration order, rollback, and measured savings.

## DDD and linked specifications

- Supporting boundary: `tooling`; state owners: Actio for task state, repositories
  for source evidence, filesystem adapter for generated digests.
- UX: UX-CC-W2/W5, UX-CC-S3/S6. Invariants: CC-DESIGN-01–04, linked to CC-INV-04.
- specRefs: [feature/design-review-handoff.md](../feature/design-review-handoff.md),
  [ux/product.md](../ux/product.md), [architecture/ddd.md](../architecture/ddd.md).
- Registered Pf project was read: `01M1XZZMEXWTFCN4HKW8K7TJKM`, name Concordia,
  anatomiaRepo concordia, uxGoalRevision 3. This does not approve the new spec.
- Registered Anatomia domain endpoint was read and contains tooling. Its map is
  for the registered main checkout, not this unmerged worktree. Local domain
  membership and specRefs were checked directly and extended before implementation.
- `anatomia plan --project concordia --no-llm` returned a tooling candidate, but
  also warned about Git ignore fallback and invalid unrelated domain definitions.
  The captured command exited 1; it is partial evidence, not a clean verification.

## Validation and recovery

- Passed: Node syntax checks for the new .mjs modules and test files; syntax
  parsing of all three Workflow bodies with AsyncFunction, without executing them;
  acceptance/domain JSON parsing; `git diff --check`.
- Passed: `npm run build:spec-index`, including the handoff and new feature spec.
  First invocation failed due to absent js-yaml in the worktree; a local ignored
  node_modules junction to the existing Concordia installation enabled the build.
  This is not a fresh npm-ci or independent dependency installation verification.
- Added, not executed: tests/design-review-handoff.test.mjs and
  tests/design-review-workflows.test.mjs, registered in cc.acceptance.json.
  No human permission to execute tests has been supplied in this session.
- Not executed: typecheck, full regression, provider Workflow agents, real-service
  checks, startup/restart, deployment, merge and main update.
- Recovery: fix invalid inputs and rerun; partial inputs require explicit choice.
  Outputs are not atomically published as a six-file transaction; after any write
  failure, do not consume the incomplete set. Reverting this unit changes no DB.

## Remaining programme work

Remaining six repository maps plus the second Cc reader, both cross-service
scouts, six analysis dimensions and both verification lenses remain unexecuted.
The Workflow-specific runtime is not connected here; current code inspection can
continue locally, but these exact jobs must not be reported as completed.
The three historical maps need revision reconciliation before reuse as current
evidence. Per-repository proposals and accepted source-service implementations
remain separate work, along with review and reflection of this first unit.
