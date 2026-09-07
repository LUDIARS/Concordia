---
type: feature
title: "Fenced worker leases"
service: concordia
domain: runtime
status: implemented
updated: 2026-09-07
---

# Fenced worker leases

Chat, workflow, and cost workers acquire their role-specific key with a SQLite
compare-and-swap. A lease records `owner`, `pid`, `expires_at`, and a monotonically
increasing `fencing_token`. Heartbeats may extend only the exact value owned by
the worker. Release also compares the exact value, so a delayed stop from an old
worker cannot delete its successor's lease. An active lease cannot be overwritten;
after expiry, the successor increments the prior fencing token.

Lease ownership is also a runtime lifecycle gate (`UX-CC-W5`, `CC-INV-07`). A
compare-and-swap mismatch reports immediate ownership loss. Repeated heartbeat
errors report loss no later than the last confirmed expiry. Chat, workflow, and
cost workers attach the loss observer before enabling their consumers, check
ownership again across asynchronous initialization, and quiesce their runtime
before releasing the database. An expired or replaced worker therefore cannot
continue consuming work beside its successor.
