---
type: feature
title: "Concordia product brief (Omnipotens baseline)"
service: concordia
domain: session-coordination
status: implemented
updated: 2026-07-16
---

# Concordia product brief

## Product intent

- **[source]** Concordia is a local service for coordination, awareness, and durable records across concurrent AI coding-agent sessions (`README.md:3-6`).
- **[source]** It addresses duplicate work, invisible peer activity, lost-session handoff, manual end reports, and poor fleet visibility (`README.md:19-31`).
- **[analysis]** The central value proposition is not “more autonomous agents”; it is safer parallelism with lower coordination loss while preserving agent autonomy.

## Primary users and jobs

| User | Job to be done | Evidence |
|---|---|---|
| Multi-agent developer/operator | See who is working where and avoid overlapping edits | `README.md:19-31`, `src/testing/branch-watch.ts` |
| Session owner | Recover or hand off work when an agent stops or becomes lost | `README.md:55-65`, `src/sweeper.ts` |
| Team lead | Observe progress, cost, conflicts, and completion state across sessions | `spec/README.md`, `web/src/pages/` |
| Automation author | Delegate work through reusable templates and provider adapters | `spec/feature/delegation.md`, `src/delegation/service.ts` |

## Verified capabilities

- **[source/code]** Session lifecycle, event capture, lost detection, recovery, worktree advice, reports, and Web monitoring are declared as primary functions (`README.md:55-65`) and represented in `src/api/`, `src/control/`, `src/work/`, and `web/src/`.
- **[code]** Discord and Slack integration, delegation, testing claims, cost/metrics, MCP surfaces, and separate chat/cost workers exist in the pinned source tree.
- **[test]** At the pinned commit, 218 Vitest files and 1,572 tests pass; TypeScript checks and dependency-cruiser pass across 521 modules and 1,955 dependencies.
- **[analysis]** The implementation has advanced materially beyond the README’s “v0.1 scaffold” and “Gemini / Codex stub” wording (`README.md:70`, `README.md:203`), so the top-level product narrative is stale.

## Product principles

1. Preserve autonomous work; conflict coordination is advisory rather than a global lock (`README.md:6`, `README.md:67-73`).
2. Keep core session coordination available when optional chat or cost surfaces fail (`spec/plan/refactor-3axis-architecture.md`).
3. Treat local data, transcripts, credentials, and remote-control capability as explicit trust boundaries.
4. Make recovery, refusal, undo, and handoff first-class, not exceptional flows.

## Non-goals for this review

- **[source]** Concordia is not a game. Gameplay, player progression, game economy, and entertainment-depth judgments are not applicable.
- **[analysis]** No service was started or restarted. Runtime behavior was assessed from tests, source, specifications, and generated static reports.
- **[question]** Public packaging, pricing, support commitments, and an externally validated target segment are not specified.

## Outcome measures

- Conflict detections that lead to isolated work before overlapping writes.
- Lost-session recovery and handoff completion rate.
- Time from session start to accurate shared state.
- Core API availability while chat/cost workers fail.
- False-positive notification rate and operator alert fatigue.
- Setup completion and time to first useful multi-session view.
