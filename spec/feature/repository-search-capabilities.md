---
title: Repository search capability guidance
type: feature
id: CC-REPO-SEARCH-01
service: concordia
domain: session-coordination
status: draft
---

# Repository search capability guidance

After a registered work repository is determined, Concordia inspects a bounded set of existing manifest, source, and known search-tool locations and gives the session a short search route. This supports UX-CC-W1 (the correct work target), W4 (the next action is clear), and W5 (uncertainty survives reconnect), with CC-INV-01/04 and CC-NODE-01/02. A person who loses this guidance may spend a session searching the wrong repository or mistake an installed tool for a working language server.

The selected repository owns the source facts. Cc owns only an expiring observation of that repository on the Cc host. A source or configuration observation is not an assertion about the remote agent terminal. Reports distinguish installed, configured, and actually callable; a tool that was not invoked has `callable: unknown`. The inspection never launches a language server, downloads dependencies, or prints secret settings. Missing project registration or unresolved target yields no repository-specific claim.

The use case reads root manifest names and a bounded, shallow sample of source names, excluding dependency, build, Git, Unity generated, and other generated directories. It checks known local binary paths and selected PATH entries by file existence. Claude configuration is parsed structurally: an enabled known plugin or enabled MCP server command can establish configuration; disabled entries and arbitrary matching text cannot. Other provider configuration without an understood schema remains unknown. It coalesces concurrent requests and caches results briefly by repository identity and provider; a changed binding or provider cannot publish an earlier result. Directory depth, item, and read limits appear as `sampleLimited` with reasons. At most four distinct inspections run together; the requester gets an unavailable result after the response deadline while the underlying inspection retains its slot until it settles.

The basic guidance asks the agent to confirm the repository's available search tools. For a named feature, the Anatomia extension adds navigation through its prepared business/program domain catalog only after human conversation, explicit repository binding, and the target's registration and API URL have been confirmed. The prepared locator requires an explicit Anatomia preparation and reports its own freshness. Broad research and refactoring do not assume one domain function is the landing point. For exact definitions, references, or bug investigation, use an available LSP in the agent terminal if it is actually callable there; otherwise use the repository's search tools. Installation or server startup remains a separate human task. The extension rules are specified in `spec/feature/inject-context-gating.md`.

Acceptance: a registered TypeScript repository yields language evidence and bounded search guidance without spawning processes; an absent tool or unobserved remote terminal never appears callable; a provider switch invalidates the old guidance; unregistered targets do not receive repository-specific guidance; concurrent requests share one bounded inspection.
