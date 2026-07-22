---
type: feature
title: "Fenced worker leases"
service: concordia
domain: runtime
status: implemented
updated: 2026-07-22
---

# Fenced worker leases

Chat, workflow, and cost workers acquire their role-specific key with a SQLite
compare-and-swap. A lease records `owner`, `pid`, `expires_at`, and a monotonically
increasing `fencing_token`. Heartbeats may extend only the exact value owned by
the worker. Release also compares the exact value, so a delayed stop from an old
worker cannot delete its successor's lease. An active lease cannot be overwritten;
after expiry, the successor increments the prior fencing token.
