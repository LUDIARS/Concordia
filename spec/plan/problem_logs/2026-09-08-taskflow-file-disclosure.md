# Task workflow content replication

- Date: 2026-09-08
- Status: fixed in working tree; runtime validation pending
- Area: Cc task workflow v3.0
- Source: neco's request; Pf fragment 01M206XEV4JRC1N3PMEZGGN2P5

## Evidence

The user identifies an incident requirement behind moving task records to Actio. Incident details and affected data have not been provided.
TaskMdStore scans spec/tasks and writes residual task files. Bootstrap starts Markdown-to-Memoria reconciliation. PR generation reads task files and copies their contents.

## Fix requirements

Actio is the content authority. Stop normal task-file writes/reads and Memoria reconciliation. Authenticate and scope Actio operations; fail explicitly when unavailable. Preserve request identity during retries. Do not copy incident details into this log.

## Verification

No tests authorized. Review data paths, request identity, scope enforcement and failure handling statically. Runtime validation and migration require separate authorization.
