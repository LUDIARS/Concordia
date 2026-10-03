---
id: CC-MODEL-CATALOG-PORT
status: draft
---

# Model catalog resolution contract

Cc owns adopted role snapshots independently of editable candidate CRUD rows.
The structural consumer port is `resolve({provider, role, context?})`, returning a
Promise of `{schemaVersion: 1, provider, role, modelId, revision, observedAt, expiresAt, capabilities, source, pinned}`. Unknown schema versions are rejected. Revision is
an opaque string, dates are UTC ISO8601, and capabilities contains
`reasoningEfforts: string[]`, `inputModalities: string[]`, optional `contextWindow`.

`GET /v1/model-catalog/roles/:provider/:role?context=...` returns this object.
Unknown roles return 404; expired or unavailable snapshots return 503 with an
explicit reason. No secret, provider credential or local cache path is exposed.
Context is a capability constraint, never text appended blindly to a model ID.
The caller supplies an endpoint resolver; the reusable library imports no Cc SDK.
Disabled dynamic resolution performs no communication. Explicit IDs and explicit
environment overrides take precedence. Enabled resolution errors never silently
fall back to bundled values. Existing synchronous library exports stay synchronous.

Manual pins are preserved by refresh. Rollback explicitly selects a historical
snapshot at a new revision. Running sessions retain their launch model.
