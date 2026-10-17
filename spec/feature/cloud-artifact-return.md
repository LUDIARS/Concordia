---
id: CC-CLOUD-ARTIFACT-RETURN
status: draft
domain: cloud-execution
---

# Artifact return revision — 2026-10-17

Human instruction: neco requests hosted setup instructions, defines local artifact storage and CF routing on behalf of the operator, wants a fresh access credential per work request, prefers non-Git file transfer when sufficient, and rejects permanently fixed job parameters. Existing Actio b0483e60-297d-4dc6-a4bf-54e1f8752e04 owns this work. Blender/preparation is reported installed by the human; no reinstall was performed.

## Fixed configuration versus individual work

Fixed: provider account/environment, authorization scope, receiver identity and storage root.
Per run: repository/source revision, actual clone-size evidence, compute/LLM reasons, output names and output budget.
Cc's calling agent derives these from the actual task; the operator need not invent future job values.
API and MCP accept a `work` object and freeze it in the durable intent. Changed work under the same attempt ID is rejected; collection uses the original snapshot. Legacy target configuration remains readable.
The Web form still needs per-run plan preparation; absence of a plan is an explicit failure, not empty placeholder data.

## Defined receiver

### Tailscale ingress — authorized startup revision

Human instruction: start port 11114, including implementation and deployment needed to make it start. UX-CC-W2/W3/W5, scenarios S3/S4: preserve received work after disconnect without confusing acceptance with reviewed completion. Supporting domain `cloud-execution` owns upload grants, receive intents and receipts; Revisor still owns review, Excubitor owns process lifetime.

CC-ART-01: dedicated `concordia-cloud-artifact` process, catalog port 11114, binds only the locally discovered Tailscale IPv4 address. No fallback to wildcard or localhost. General Cc API is not mounted. The previous Git ingress implementation remains available separately, but its service does not simultaneously claim 11114.
CC-ART-02: private HTTP over Tailscale, exact listener Host, no CORS/browser upload, per-run random capability (digest only on disk, maximum six hours). Tailscale access rules must restrict destination and port. Cloudflare remains a separate unconfigured public transport, never an authentication bypass.
CC-ART-03: local trusted application issues a grant bound to target/run, one artifact filename and byte limit. Multiple outputs use an archive as opaque bytes; the receiver never extracts it. Runtime output names/limits are not permanent service settings. Authorization is checked before receiving and before committing. No grant-creation endpoint is exposed remotely.
CC-ART-04: PUT `/artifacts/:target/:attempt` with Bearer capability, `application/octet-stream`, exact Content-Length and `X-Artifact-Sha256`. Stream into an exclusively created intent's partial file, verify bytes/hash, fsync, then write completion receipt last. No overwrites or replacement grants. GET of the same URL returns authorized receipt or pending/unknown state. Two concurrent transfers maximum, bounded request duration. Failed/interrupted intent is retained, never automatically retried; inspect it and use a new attempt after reconciliation. Successful retry returns the saved receipt only for identical declared hash/length.
CC-ART-05: root is operator-owned `artifact`; startup rejects a symlink/non-directory root. Namespace components are validated, grant/receipt files use exclusive creation. Stop admits no new requests, drains bounded uploads, and retains incomplete intents on forced shutdown. Recovery is stopping the service via Ex; stored artifacts remain. Startup acceptance: authenticated binary roundtrip plus rejected unauthenticated/oversize/cross-run writes; cloud connectivity is separate from local listener verification.

- Storage root: `E:/Document/Ars/artifact` (created and existence checked).
- Dedicated desired hostname: `artifact.ai-run-do.com` (not registered or collision-checked yet).
- Per-run namespace: `<repository identity>/<attempt ID>/`; no user-supplied absolute path.
- Preferred transport for model/render/binary outputs: HTTPS file upload through Cloudflare Tunnel, not SSH/SCP or a required Git commit. Preserve Git as optional for versioned source changes and S3 for explicitly chosen external storage.
- Reuse bounded streaming, hash/size verification, exclusive receive intents and completion-last markers. Reject path traversal, links, overwrite and cross-run upload. Incomplete results never become downloadable.
- A source change received as files does not bypass Revisor; promotion remains a separate reviewed operation.

The Tailscale HTTP file receiver is implemented separately from the earlier Git receiver. Local trusted callers can issue a grant through `ArtifactReceiver.issue`; automatic provider dispatch to this transport and UI plan preparation remain outstanding. No cloud upload or deployment has been verified yet. The Cloudflare HTTPS route is not configured.

Validation of this revision: 171 backend/API/MCP tests passed, including binary receipt, restart reconciliation, concurrent receive exclusion, expired/cross-run/wrong tokens, bad hash and oversized body. Production TypeScript check passed. Whole-repository regression, live Tailscale request, actual cloud work and deployed process remain unverified. Existing Revisor PR #3148 remains action_required on its earlier head; this change does not override that gate.

## Access credentials

Use a dedicated Cloudflare Access service-auth application. Issue a separate expiring service token for each authorized run, restricted to this application; revoke it after receive completion/expiry. Do not rotate one shared token underneath concurrent runs. A Cloudflare service token can authenticate multiple requests during its life; the artifact receiver separately enforces run/file identity and one completion.
Keep the Cloudflare account administration credential in the existing local secret binding. Never send it to a cloud agent. Per-run CF token is separate from the local upload capability and from Claude's routine fire token.

Cr research: `SPEC-WORKLOAD-AUTHORITY`, `server/src/workload/input.ts`, `authority.ts`, `claims.ts`. Cr issues 60-second opaque workload tokens and validates exact grants online. Current allowed actions do not include artifact upload. Such a token is not a Cloudflare Access service token. No Cr changes or grants were made; do not claim native Cloudflare acceptance. Anatomia cernere context was queried; repository spec and implementation are the direct evidence. Pf project exists (01M3FVMF9VM713AVRRWE44WMCP), matching spec registration was not confirmed.

## Actual configuration blocker

Existing authorized CF CLI bootstrap `Cernere/.env.secrets` failed its read-only authentication/configuration path: sandbox request failed, elevated read returned HTTP 530. No account/zone/tunnel/DNS/application/token identity was obtained. No CF mutation or secret issuance occurred. Do not treat 530 as proof of missing API permissions, choose another credential, or publish an unprotected hostname. Restore/identify the existing secret service endpoint before CF writes.

## Provider setup evidence

Codex official current guide: Settings > Codex Cloud > Environments, select/create environment, connect requested GitHub repository, review prepared setup and Publish. Existing prepared environments should be reused. Local CLI ChatGPT authentication uses `codex login`; device flow is `codex login --device-auth` when enabled. Current official docs distinguish new cloud environments from legacy cloud. Installed CLI exposes experimental `cloud exec`; compatibility with the selected new environment is unverified until authenticated. No environment ID is invented.

Claude: claude.ai/code/routines > New routine > choose cloud environment and Tokyo2070 repository > API trigger > Create. Edit > API trigger > Generate token; preserve URL and store the once-shown secret in the approved service secret store. Saved instructions must explicitly authorize executing Cc's `routine-fire-payload`; exclude irrelevant connectors and GitHub publication. The routine URL identifies the trigger. Do not ask the human to send the secret in chat.

References checked 2026-10-17:
- https://learn.chatgpt.com/docs/environments/cloud-environments
- https://learn.chatgpt.com/docs/auth
- https://code.claude.com/docs/en/routines
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/
