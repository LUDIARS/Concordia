---
id: SPEC-PLAN-APPROVAL-NOTIFICATION
status: draft
---
# Provider plan approval notification

2026-10-03 neco implementation request; Actio 908fc672-8587-4e9e-b943-9e6682d6af42.
UX-CC-W4/W6, CC-INV-02/03/06/08. A user must notice a provider's plan approval dialog before answering and must not answer a stale or different request.

Lictor owns provider observation and picker delivery. Cc owns the durable pending question and its existing authorized answer lifecycle. Extend pending-question with `kind=plan_approval` and `provider_request_id` (provider tool_use ID). Both are required together. Persist request identity scoped to session; retries, including after an answer, return the same question. Distinct IDs with identical plan text are distinct requests. Never infer approval from notification, elapsed time or plan text. Existing ordinary question, permission and delegation escalation behavior remains.

PreToolUse ExitPlanMode observation reaches Cc through Lictor before the local dialog is answered; it does not emit an allow/deny decision. Register the existing picker response path with the same tool ID. Transcript replay carries the same identity and local tool-result resolves the same saved question. Notifications remain visible in final-only departments through existing question adapters. Plan text is displayed only in the existing session/parent scope.

The persistence migration only adds nullable identity columns and a unique session/request index; no historic records are reclassified. Rollback to earlier code ignores the added columns. New Lictor must be rolled out after Cc so identity validation is available. Tests cover retry, same text/new ID, session isolation, answered replay and typed notification projection; runtime/Discord checks remain separately authorized.
