---
type: plan
title: "Omnipotens source manifest — Concordia"
service: concordia
domain: analysis-core
status: partial
updated: 2026-07-16
---

# Source manifest

## Retrieval record

- Retrieval time: `2026-07-16T09:09:27+09:00`
- Method: isolated Git worktree from freshly fetched `origin/main`; local filesystem inspection; deterministic local tools.
- Concordia commit: `b8f3ed7e1d11ce746344281884b08c6538506eb4`
- Branch/worktree: `docs/omnipotens-concordia-analysis` / `E:/Document/Ars/.wt-Concordia-omnipotens`
- Original checkout was dirty and on another task branch; it was not edited.
- No external planning URL was supplied. The repository `README.md`, `spec/`, source, tests, and existing review files are the source baseline.

## Tool and reference pins

| Tool/reference | Version or commit | Use |
|---|---|---|
| Node.js | `v24.14.1` | renderers and project checks |
| npm | `11.11.0` | test/lint commands |
| Python | `3.14.3` | Vitia deterministic scoring |
| Git | `2.24.1.windows.2` | source pin and worktree isolation |
| Anatomia | `2b09de8f79f4c205f6cb797a3135316e764ef56e` (`0.1.0`) | code graph and architecture health |
| AI Format | `ff3edc1a927170d1728df10f635af28fd000dd7c` | structure, privacy, and review criteria |
| Ludus | `ccd38ccbb55d8871cffb40198cfa8beb62af1b42` | applicability decision only; no game IDs selected |
| Vitia | `382de6a345279d2967e03e19918a0931088e91e1` | marketability routing |
| Discutere/Di | `5640fda49e1759a1ce07cfa677e39c5b5379563d` | discussion stage, subject to service availability |

## Coverage

- 643 TypeScript/TSX files parsed by Anatomia; 5,532 functions; 6,766 resolved call edges.
- Unsupported/failed parses: 0 files.
- Unresolved calls: 4,574 (`no-local-candidate`), so orphan, cohesion, and coupling results are conservative static approximations.
- Tests: 218 files / 1,572 tests passed.
- Lint: TypeScript source + test configs passed; dependency-cruiser passed (521 modules / 1,955 dependencies).
- AI Format: six categories present; Grade A; zero structural/privacy findings.
- Visual UX run: unavailable because no browser connection was available; static evidence only.

## Stage status

| Stage | Status | Reason / downstream impact |
|---|---|---|
| 1 Specification baseline | complete | Repository sources pinned; product/system baseline created. |
| 2 Ludus play analysis | not-applicable | Concordia is not a game; no gameplay claims or IDs fabricated. |
| 3 Domain model | complete | Existing ten-domain specification preserved byte-for-byte as the baseline. |
| 4 Anatomia | complete | Spec-domain and built-in comparison reports generated. |
| 5 Spec/domain/code wiring | partial | Important rules mapped; 114 static spec-gap file candidates require human triage. |
| 6 Mechanics/economy | not-applicable | Game mechanics/economy absent; operational value loops documented separately. |
| 7 Formal/architecture review | complete | Detailed renderer, AI Format, lint, and tests completed. |
| 8 UX | partial | Static review completed; live/responsive interaction could not be inspected. |
| 9 Vitia | complete | Deterministic score plus ethical strategy hypotheses produced. |
| 10 Di | blocked | Discutere health passed, but required `start-from-paper` returned HTTP 404; no session/result exists. |
| 11 Final report | partial | Runs after the last reachable stage; reflects all omissions explicitly. |

## Data handling

- Excluded: `.env`, secret keys/tokens, SQLite databases/WAL files, logs, private transcripts, and raw private discussions.
- Ludus dictionary content was not copied. Only its commit and the `not-applicable` decision are recorded.
- Heuristic scores are prioritization aids, not proof or release gates.
