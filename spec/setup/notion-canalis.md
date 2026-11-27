---
title: Canalis Notion full-text checks
type: feature
id: CC-NOTION-FULLTEXT-01
domain: governance
status: draft
---

# Canalis Notion full-text checks

Human instruction: neco, 2026-11-03, check full text with Canalis before Claude reads every page.
Related Actio task: `fa4a9caf-87cc-4360-b465-2872dc22a38b` (read as open; not marked complete).
Value: UX-CC-PATROL-01. The governance support domain owns change detection and existing Notion map state;
Canalis owns browser extraction. This supports conversations and consultation, not a new core domain.

## Contract

- Read accessible pages through Canalis before any MCP/Claude fetch. Reuse this body, avoiding a second retrieval.
- Hash the full rendered Markdown, title and links before clipping the stored excerpt. Detect edits after byte 6000.
- Do not resummarize unchanged pages, including manual refresh; manual refresh still checks the network source.
- Empty, inaccessible and scroll-limit results are not proof of no change. Explicitly log capability fallback to the
  existing authenticated MCP reader. Missing library/build/browser is configuration failure, never silent fallback.
- Keep the old root on collection exceptions; release the browser in finally. Continue checking exclusion rules.
- Keep the seven-day scheduling policy and existing retention on failed acquisition. No new TTL cache or credentials.

## Dependency and communication review

`lib/canalis` is pinned to `af4482bd20f0cab9a47233ce2fc1413bd615b070` (local seven-day history had no changes).
Initial public-Notion source, extraction, types and crawler were inspected. No remote freshness claim is made.
Only the public-Notion entry point is compiled. Playwright is required for client rendering; raw fetch would
repeat the original empty-HTML failure. Fingerprinting, URL checks and clipping use Node built-ins.

Production lock resolves Playwright / playwright-core 1.60.0 (Apache-2.0), js-yaml 4.2.0 (MIT) / argparse 2.0.1 (Python-2.0)
(library-wide dependency, not imported by this reader), and optional platform fsevents. The exact submodule
lockfile owns artifact integrity. Do not install development Kuzu, Vitest, tsx or duplicate compiler dependencies
for this reader. Bootstrap uses `--omit=dev --ignore-scripts`; native/install hooks are not executed.
The Cc TypeScript compiler builds only the selected boundary. The browser is a native dependency: type safety
in this adapter is not a memory-safety audit of Chromium. No browser execution/security validation was performed here.

Traffic is initiated only during refresh: the selected HTTPS Notion page and its rendered assets, then existing
authenticated Notion MCP only on capability loss. Browser startup is lazy, uses a fresh browser with no copied
user profile/cookies, and the adapter never sends environment values or secrets as URL/body/prompt data.
No telemetry/export calls were found in the imported reader boundary. Browser assets/network behavior require
authorized runtime validation. No registry installation or browser download was executed during implementation.

Canalis originally returned content after exhausting maxScrolls. The small, deterministic post-build patch
`scripts/patch-canalis-notion.mjs` requires two stable height observations and throws on the scroll limit.
It checks the expected pinned function shape and fails the build if upstream changes. It patches generated
output only, leaves the submodule clean, and must be re-reviewed whenever its pin changes. This avoids accepting
a known truncated result as a full-text fingerprint; it does not certify hidden/toggle content that Notion never renders.

## Setup and recovery

1. Initialize pinned submodules using the standard repository bootstrap. It installs production Canalis
   dependencies without hooks and compiles/patches the reader. No sibling checkout paths are required.
2. Provision the Chromium version selected by the pinned Playwright using the normal approved installation
   process (`node lib/canalis/node_modules/playwright/cli.js install chromium`). This can download a browser;
   it has not been executed or approved by this implementation session.
3. Deploy through the service's normal review / Excubitor process. Verify a known unchanged page causes zero
   MCP fetch calls and no new summary, and a tail edit updates its fingerprint. Private pages may still require MCP.

Rollback: revert the Cc change and its Canalis gitlink; existing content_hash accepts the versioned string without
schema migration. Legacy readers recompute their old fingerprint on the next refresh. No stored knowledge deletion.

## Verification

Registered tests cover tail edits, link/title changes, URL rejection, unchanged manual refresh, capability fallback,
configuration failure, failure preservation and browser disposal. Unit/integration/browser tests have not been run
because the session rules require explicit test authorization. Source and Canalis-boundary typechecks passed;
the whole test-project typecheck reports five existing ProviderName assignment errors in two control test files.
