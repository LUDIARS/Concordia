# Test Forum session received authority over Revisor mutations

- Date: 2026-08-07
- Status: fixed in working tree
- Area: Discord Test Forum / session spawn / Revisor authorization
- Severity: high — an interactive LLM could choose and execute workflow state changes

## Summary

A follow-up to the Test Forum session reuse fix delegated Concordia's Revisor workflow token to the verification session. That resolved a `401 unauthorized` symptom but moved service-owned mutation authority into an interactive LLM process.

neco rejected that ownership model:

> Rvの挙動をLLMが判断するな
> 機械的処理はシステムで安定的に処理できるようにしろ

## Cause

The earlier change treated the ability to complete a human merge instruction as a missing credential problem. Concordia already had a deterministic path: the Test Forum merge button checks the `merge_pr` capability and invokes the Revisor merge API through a Cc-owned client. Revisor also owns its automatic merge eligibility state machine. The verification session did not need mutation authority.

The child environment builder stripped an ambient workflow token, but allowed a caller to add the same token back through explicit spawn env. The Test Forum spawn route used that exception and instructed the LLM to call mutation APIs.

## Fix Requirements

- Keep Revisor workflow and trigger credentials inside Concordia service processes.
- Strip both credentials from inherited and explicit interactive-session environments.
- Keep Test Forum sessions limited to verification and reporting.
- Route explicit human merge through the existing capability-checked Test Forum button.
- Leave automatic eligibility and merge decisions in Revisor's deterministic state machine.
- Do not parse Test Forum natural language into Revisor mutation commands.
- Retain the persisted `starting` reservation and same-thread session reuse behavior.

## Verification

Regression coverage now asserts that neither Revisor credential can reach an interactive child even when explicitly supplied, and that the Test Forum prompt exposes no workflow token. The existing merge-control coverage continues to exercise the Cc-owned Revisor client path. Tests were not run in this session because the session policy forbids test execution without explicit user instruction.
