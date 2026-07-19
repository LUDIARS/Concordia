---
type: setup
title: "Reproduce the Omnipotens review"
service: concordia
domain: tooling
status: complete
updated: 2026-07-16
---

# Reproduce the review

## Source

1. Fetch `origin/main` and check out commit `b8f3ed7e1d11ce746344281884b08c6538506eb4` in an isolated worktree.
2. Use Node `v24.14.1`, npm `11.11.0`, and Python `3.14.3` or record replacements in `spec/data/tool-manifest.json`.
3. Install dependencies normally. The original run reused an existing local `node_modules` through a junction; this is not part of the committed artifact.

## Verification commands

```powershell
npm test -- --reporter=dot
npm run lint
node E:\Document\Ars\AIFormat\scripts\check-spec-structure.mjs <repo>
node E:\Document\Ars\AIFormat\scripts\check-personal-data.mjs <repo> --json
node E:\Document\Ars\Anatomia\bin\anatomia.mjs spec-review --repo <repo> --json
python E:\Document\Ars\vitia\scripts\score_vitia.py spec\data\vitia-input.json
```

## Anatomia reports

Copy the locked JSON definitions from `spec/data/anatomia-domains/` into an ignored runtime plugin directory and set `ANATOMIA_PLUGIN_DIR` to it. For the exact-baseline aggregate, override generic built-ins with empty membership; keep a second run with unmodified built-ins for comparison.

```powershell
node <review-report-html>\scripts\render-anatomia-review.mjs --repo <repo> --anatomia <Anatomia> --output report\architecture-review-spec-domains.html --title "Concordia — specification-domain baseline"
```

## Final package

```powershell
node <omnipotens>\scripts\omnipotens-report.mjs --project <repo> --title Concordia --include report\architecture-review-spec-domains.html --include report\architecture-review.html
```

Do not start Concordia or dependent services from a worktree. If runtime testing is later approved, claim the test through Concordia and use the approved lifecycle controller from the project’s primary folder.
