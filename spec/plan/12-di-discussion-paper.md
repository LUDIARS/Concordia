---
type: plan
title: "Di discussion paper — Concordia Omnipotens review"
service: concordia
domain: governance
status: blocked
updated: 2026-07-16
---

# Di discussion paper

## Decision context

Concordia is local multi-agent coding-session coordination software, not a game. Debate the mandated Omnipotens questions using “fun and deep” only as an analogy for sustained usefulness, legibility, and strategic depth. Do not invent gameplay conclusions.

## Evidence summary

- Source pin: Concordia `b8f3ed7e1d11ce746344281884b08c6538506eb4`.
- Product intent: make concurrent sessions visible, recoverable, and less collision-prone without imposing a global lock (`README.md:3-31`, `README.md:67-73`).
- Verification: 218 test files / 1,572 tests pass; TypeScript and dependency-cruiser pass across 521 modules / 1,955 dependencies.
- AI Format: Grade A, all six categories present, zero structural/privacy findings.
- Anatomia: 643 files, 5,532 functions, 6,766 resolved calls, 0 skipped files, 4,574 unresolved calls.
- Exact specification-domain heuristic: 54.7 design strength; 88.1% coverage; 58.0% cohesion; 13 function-cycle groups; 114 spec-gap candidates.
- Top structural risk: `DelegationService` risk 79.8 across five domains. Top complexity: `startBackend` 84, `startDiscordBot` 69, `registerCoreRoutes` 52, `startSlackBot` 48.
- Strong boundaries: chat cohesion 76.8%, observability 68.9%; dependency-cruiser has zero prohibited violations.
- Contradiction: README still says Gemini/Codex are stubs and v0.1 scaffold (`README.md:70`, `README.md:203`) despite current code.
- UX: static review only; browser/live runtime unavailable. Main proposal is exception-first overview, clear recovery timelines, and role-based setup.
- Marketability: Vitia routes to Avaritia 0.651 + Ira 0.647 — prove avoided coordination loss and restore control; do not claim unmeasured ROI.

## Debate questions

1. **Is it fun and deep?** For this non-game tool: does repeated use create a clear, trustworthy sense of control and increasing coordination leverage, or merely another monitoring burden?
2. **Can it sell?** Is “visible, recoverable parallel agents without locks” differentiated and provable enough for a technical team to adopt?
3. **What changes improve it most?** Rank narrative/spec freshness, onboarding, authority/trust boundaries, delegation decomposition, bootstrap simplification, and alert prioritization.

## Positions to test

- Pro: broad capabilities, strong automated safety net, local-first control, and explicit recovery create credible operational leverage.
- Con: feature breadth, stale narrative, and high-complexity orchestration may make the system feel harder than the coordination problem it solves.
- Alternative: narrow the initial product around conflict visibility + lost-session recovery, with delegation/cost/chat as progressive capabilities.

## Required output

- Preserve disagreements rather than forcing consensus.
- For each recommendation, state evidence, assumption, confidence, expected impact, cost band, risk, and validation method.
- Separate verified claims from hypotheses.
- Return a prioritized top five and name one tempting change that should not be done yet.

## Service result

The Markdown paper is complete. Discutere health was reachable through the URL resolved from the Excubitor catalog, but `POST /api/flow/start-from-paper` returned HTTP 404. The pinned Discutere source also contains no `start-from-paper` route. No `sessionId` or concluded discussion exists, and the missing capability is not replaced with fabricated debate output.

- Stage status: `blocked`
- Blocking capability: paper-first auto-start endpoint required by Omnipotens
- Downstream impact: final report includes the prepared paper and omits debate conclusions
- Resolution choices: implement/repair the endpoint, wait for a compatible Discutere deployment, or explicitly accept the Di omission
