---
type: plan
title: "Ludus play analysis — applicability decision"
service: concordia
domain: analysis-core
status: not-applicable
updated: 2026-07-16
---

# Ludus play analysis

Status: `not-applicable`.

Concordia is multi-agent coordination software rather than a game (`README.md:3-6`). It has no player role, authored challenge structure, win/loss condition, entertainment progression, or game economy. Mapping operational workflows to Ludus play IDs would falsely imply gameplay semantics.

- Ludus source pin: `ccd38ccbb55d8871cffb40198cfa8beb62af1b42`
- Selected stable IDs: none
- Local overrides: none
- Dictionary content copied into Concordia: none
- Downstream impact: game-fun/depth and play-taxonomy conclusions are omitted; workflow UX and operational feedback loops are reviewed in stages 6 and 8.

This decision follows the Ludus data-governance boundary: project-specific operational knowledge remains local and is not written back to the public dictionary.
