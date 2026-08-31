# Subsidiary Discord Clients Amplified Memory Use

- Date: 2026-08-31
- Status: fixed in working tree
- Area: subsidiary Discord runtime / team ownership
- Severity: high — each enabled subsidiary duplicated a full Discord gateway client and its guild caches

## Summary

Concordia models subsidiaries as logical Discord runtimes, but each runtime currently constructs and logs in a separate `discord.js` `Client` even though every subsidiary uses the head-office bot token. Memory therefore grows with the number of subsidiaries because gateway state, caches, websocket machinery, and listeners are duplicated.

The same implementation also treats teams as head-office-only: subsidiary runtimes skip team provisioning, teams have no organization owner, and subsidiary delegation cannot select a default team. A task created by a subsidiary can carry subsidiary ownership, but cannot reliably enter that subsidiary's team TaskWorkflow surface.

## Evidence

- `startDiscordBot()` constructs a new `Client` on every call and calls `client.login()` with the shared head-office token.
- `SubsidiaryBotManager.startAll()` calls `startDiscordBot()` once for every enabled Discord subsidiary.
- The ready handler provisions `teams` only when `deps.subsidiary` is absent.
- `teams` has no `subsidiary_id`, while `subsidiaries` has no `default_team_id`.
- The subsidiary gate invokes its owned delegation with `subsidiary_id` only; it does not populate `options.team`.

## Cause

Logical guild isolation and physical gateway ownership were coupled in one function. Creating another logical organization therefore also created another physical gateway connection. Team storage and Discord provisioning retained the earlier assumption that all teams belong to the head office.

## Fix Requirements

- Share one physical Discord client per bot token and reference-count logical bot runtimes.
- Keep configuration, session channels, timers, and event handling logically isolated per guild/subsidiary.
- Remove every logical runtime's event listeners before releasing its shared client lease.
- Retain guild filtering at every Discord event entry point so one physical client cannot double-ack interactions or leak events across organizations.
- Give teams an explicit nullable subsidiary owner; `NULL` remains head office.
- Provision and route only the teams owned by the current logical runtime.
- Let a subsidiary select one of its own teams as its default, and propagate that team through delegation run, pending spawn, session, and TaskWorkflow routing.
- Reject cross-subsidiary default-team assignments and prevent subsidiary deletion while it still owns teams.

## Verification

- Repository/API tests should cover ownership filtering, cross-subsidiary rejection, and default-team propagation.
- Gateway pool tests should prove same-token sharing, different-token separation, login deduplication, and last-lease destruction.
- Backend, WebUI, and test-source TypeScript static checks pass in the working tree.
- Unit/integration tests were not executed under the session policy.
- Runtime verification must be performed only after review/merge, from the Concordia main folder through Excubitor with a Concordia testing claim.
