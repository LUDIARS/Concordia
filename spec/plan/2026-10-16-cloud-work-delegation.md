# Cc cloud work delegation — design draft

Status: implementation prepared for review. Admission, provider adapters, scoped
intent journal, private S3 transfer, verified downloads and operator reconciliation
are connected to the delegation API, WebUI and MCP in the worktree. The running
Cc service has not been updated. Live cloud setup and the Tokyo2070 acceptance
trial remain blocked on account/environment/storage configuration. No cloud
submission, modelling output, GPU allocation, deployment or human acceptance.

## Request and confirmed execution target

neco requested delegation from Cc to Codex and “Cloud Code” cloud environments,
primarily for Blender modelling and GPU training. “Cloud Code” is provisionally
interpreted as Claude Code, consistent with the subsequently supplied Claude design.

neco subsequently selected **only both providers' standard hosted environments**.
External GPU workers, self-hosted runners and Managed Agents are excluded. Keep
provider-specific submission separate from the shared job/artifact contract.
Neither provider's default resource documentation establishes GPU availability.
Do not infer GPU support from PyTorch installation or a cloud account. Reject
GPU-required work before submission while GPU capability is unverified; do not
silently downgrade training to CPU or allocate external compute.

neco supplied the Notion reference below and instructed that it be used as a
reference for supporting both environments. This confirms the reference's role,
not every action, completion claim or infrastructure proposal inside the page.

Additional human instruction: all four admission conditions must hold: repository
size <= 50 MB; environment preparable without cloning a large project; expensive
artifact generation; and a task requiring LLM guidance. See the normative feature
draft `spec/feature/cloud-work-eligibility.md` (CC-CLOUD-09). Tokyo2070 is an example
candidate, not a project-name bypass. The pure policy and boundary/negative tests
are registered in `cc.acceptance.json` and applied before the new submission use
case calls either provider. Existing local delegation remains unchanged. Synergos
and heavy rendering in Fg/LD are also candidates under the same four conditions.

neco subsequently instructed: implement if research/design establishes feasibility,
and use Tokyo2070 modelling as the test. This authorizes the current implementation
and modelling test; it does not establish account readiness or a passing result.
See `spec/plan/2026-10-16-tokyo2070-cloud-trial.md` for the concrete test brief.

Tokyo2070 read-only observation: at `2041a75ff2a67529ff2e790e466f449906260de7`,
201 tracked blobs total 479,986 bytes. This counts HEAD file contents only, not full
Git history, LFS payloads or dependencies, and is not final clone-size evidence.
The package manifest uses registry devDependencies; README describes a separate
Ludellus-Server endpoint for encounters. Environment readiness depends on the
requested operation, and this observation does not establish live test readiness.

## Evidence (2026-10-16)

- Source baseline: Concordia local main `34e63894`.
- `src/control/provider-preset.ts` resolves local Claude/Codex/Gemini and Satelles
  execution presets. It does not define a cloud execution target.
- `src/delegation/service.ts`, `executor.ts`, `launcher.ts`, `contracts.ts`,
  `src/api/delegation.ts`, and `src/db/delegation-repo.ts` own the existing dispatch
  and run contracts. Extend these boundaries rather than invent another task queue.
- `delegation-provider`, `delegation-launch`, and `agent-delegation` domain
  definitions describe the existing ownership. Actio owns task content/progress;
  Cc owns instruction/task links and delegation execution records.
- Praeforma project `01M1XZZMEXWTFCN4HKW8K7TJKM`, UX revision 3, is registered as
  Concordia, with Anatomia registration `concordia`. Its generic UX draft does not
  establish a cloud delegation specification or approval.
- Anatomia context returned historical delegation/spawn material and reported
  cache persistence failure (EPERM). The source files above were inspected
  directly; no cloud capability or passing verification is inferred from the map.
- Genius query was unavailable because the client rejected `decidedBy` in its
  response. No judgment card was relied on.
- The installed Codex CLI exposes `cloud exec --env <id> --branch <branch>`,
  `cloud list --json`, `cloud status`, and `cloud diff`. Help was inspected only.
  Compatibility with the account's current versus legacy environment is unverified.
- The installed Claude CLI exposes `--cloud` and `--environment` (self-hosted).
  Help was inspected only. No authenticated cloud task was started.
- Reference supplied by neco: https://candle-stoplight-544.notion.site/Blender-Cloud-3fb39cbfbab9816e94bee6b21cac2d9f
  (Notion last edited 2026-10-16T05:04:13.037Z; fetched through the Notion connector).
  Read both the Codex Blender trial and Claude Cloud lane design. A bookmark block
  was not represented by the connector; the two design sections were available.
- The reference's Claude implementation `feat/delegation-claude-cloud-lane`,
  commit `a938bc6`, is not present in this local Concordia repository. Its claims of
  implementation/test success are source-report claims, not verified local work.
  Do not overwrite another session's branch or present this commit as incorporated.
- Official Claude routines documentation confirms the fire endpoint, dated beta
  header, `text` request payload and `claude_code_session_id` /
  `claude_code_session_url` response. Its saved routine prompt must explicitly
  authorize interpreting the fire payload, which otherwise arrives as untrusted data.

Official sources read:

- https://learn.chatgpt.com/docs/environments/cloud-environments — published
  environments, private networking, and default VM resources. No default GPU
  promise. New and legacy cloud environments are distinct.
- https://code.claude.com/docs/en/claude-code-on-the-web — CLI cloud submission,
  remote checkout versus bundle input, and cloud session lifecycle.
- https://code.claude.com/docs/en/cloud-environments — hosted VM limits, setup,
  environment selection, and background/idle lifecycle limits.
- https://code.claude.com/docs/en/self-hosted-environments — organization-operated
  runners are a separate deployment route, not proof of an available GPU here.
- https://code.claude.com/docs/en/routines — use the official routine fire API for
  unattended Claude submission; the standard-hosted environment must be selected
  in the routine. This is distinct from a Claude Platform inference API request.

## Integrating the two reference designs

| Responsibility | Shared contract | Codex Cloud | Claude Code Cloud |
|---|---|---|---|
| Start | Persist intent before sending; one attempt identity | `codex cloud exec --env ... --branch ... --attempts 1` after compatibility check | Official routine `/fire`, per-routine bearer token, beta/version headers |
| Context | brief, accepted state, current instruction, input revision | New task receives the same job packet | Routine saved prompt opts in to the same job packet in fire text |
| Progress | Preserve remote locator; bounded monitoring; unknown is not failure | Supported CLI status/list plus result manifest | Session link and result manifest; no invented session polling API |
| Binary outputs | `.blend`, preview, log, result manifest in private artifact storage | Same storage contract | Same storage contract |
| Code outputs | Reviewable source diff or branch received by Cc, then Revisor | No automatic `apply` into shared checkout | No feature branch or PR published to GitHub |
| Next iteration | New job links the previously accepted scene and result | New one-shot task | New routine invocation |

The reference's signed GET/PUT URLs are credentials. Keep them out of Git, normal
logs and persisted prompts; scope to a single attempt and required object paths.
Final result is uploaded last and lists actual sizes and SHA-256 hashes. Collection
must verify bytes before exposing an artifact as received. Transfer failure is
separate from cloud execution outcome. Expired access must not launch another job.

The reference's git ingress is a possible **code-return** adapter, not the transport
for large Blender assets. Do not require a new public git server merely to receive
`.blend` and PNG files. If git ingress is adopted, preserve Access protection,
quarantine incoming packs, enforce run/repository/ref binding and limits, and verify
the exact received commit before local PR submission. Do not place credentials in
remote URLs or retained `.git/config`; use transient credential delivery.

Corrections to the reference before implementation:

1. A failed or timed-out fire response may be an unknown submission. It cannot
   universally become `spawn_failed` with permission to retry.
2. Receiving a push, or opening a local PR, does not prove the modelling/task
   acceptance conditions. Preserve received/submitted/reviewed/accepted distinctions.
3. A monitoring deadline does not prove remote cancellation or cessation of usage.
4. Instructions to push inputs or final implementation to GitHub are not adopted;
   Revisor owns release publication. Record the actual published input revision.
5. External GPU expansion in the Codex trial is excluded by the user's selection.
6. The document's cloud Access bypass option is not selected. Public exposure and
   authentication changes need a concrete reviewed configuration before execution.

The latest human instruction replaces the generic blue/red cube proposal with a
Tokyo2070 modelling trial on **each** provider. Start with a bounded CPU-rendered
street-terminal prop; verify scene reopening, GLB import, preview, logs and hashes.
The trial is authorized, but has not run. A second iteration is only needed when
the preview needs correction, within the trial limits.

## Value, boundaries, and terminology

Use existing UX-CC-W2 (retain delegated work), W3 (distinguish result/review/release),
and W5 (recover after interruption), scenarios UX-CC-S2/S3/S4.

Proposed supporting domain `cloud-execution` owns remote execution references,
capability admission, provider adapters, reconciliation, and artifact manifests.
It supports Cc's collaboration core; it is not a new core domain. Declare its
source/test membership before implementation.

- Agent provider: Codex Cloud or Claude Code Cloud, including the specific supported
  product generation and authenticated account.
- Execution target: configured standard-hosted environment ID, verified tool and
  device capabilities, memory/disk limits and duration limit. No external compute.
- Remote attempt: one submission intent with stable identity and provider task ID.
- Artifact: a preserved output with name, location, size and checksum; an output
  link alone does not prove successful retrieval or acceptance.

Domain policy decides eligibility and state transitions without network/DB/env I/O.
Application use cases authorize and persist intent before invoking an adapter.
Adapters perform official CLI/API operations, normalize provider evidence, and
never substitute local execution when cloud configuration is absent.

## Proposed flow

1. Accept an existing Actio task reference, selected provider/environment, input
   source revision, workload kind, resource requirements and expected outputs.
2. Apply existing requester/project/subsidiary authority and budget checks. Validate
   environment ownership, supported product generation and actual capabilities.
3. Resolve source delivery explicitly. Local-only worktree commits are not assumed
   to exist in the cloud. Do not push feature branches, upload whole workspaces,
   copy user credentials or bypass Revisor to make submission work.
4. Record submission intent with a stable request identity before external I/O.
   Return accepted separately from confirmed running. Persist the remote locator.
5. Reconcile by that locator after interruption. A timeout after submission is an
   unknown result, never permission to create another job. If the provider cannot
   resolve an uncertain submission, require operator reconciliation.
6. Preserve output manifests and execution evidence. Deliver Blender `.blend`,
   preview images and requested export formats; for training preserve checkpoints,
   configuration, metrics and logs. Storage destination must be configured.
7. Mark execution complete only after provider evidence and output validation.
   Keep review, user acceptance, merge and deployment as separate existing states.

## Invariants and acceptance cases

- CC-CLOUD-01 / CC-INV-02: an unconfigured, inaccessible or wrong-owner target is
  rejected before dispatch; unknown GPU capability rejects GPU-required work.
- CC-CLOUD-02 / CC-INV-03: duplicate request, timeout, process restart and concurrent
  delivery cannot produce a second submission for the same remote attempt.
- CC-CLOUD-03 / CC-INV-01: transmitted source revision and selected environment are
  recorded and match the task; local paths and cloud paths are not interchangeable.
- CC-CLOUD-04 / CC-INV-04: queued, running, failed, interrupted and unknown provider
  outcomes are distinguishable. CLI exit zero is not job completion.
- CC-CLOUD-05 / CC-INV-05: missing artifacts, checksum mismatch, an unverified
  checkpoint or absent acceptance evidence cannot produce accepted completion.
- CC-CLOUD-06 / CC-INV-07: cancellation, timeout, lease loss and provider expiration
  preserve known outputs and execution IDs; stopping the local CLI is not claimed
  to cancel remote work. Unsupported cancellation is explicitly reported.
- CC-CLOUD-07: only standard provider-hosted execution is allowed. Unknown GPU
  capability rejects a GPU-required request. No external allocation or silent CPU
  fallback is allowed. CPU work has explicit runtime/iteration limits.
- CC-CLOUD-08: external credentials stay in the approved secret store; command
  invocation uses argument arrays without a shell; raw provider output is not
  blindly copied into logs, user messages or the task database.

Register source/test pairs in `cc.acceptance.json`. Test policies with fixtures,
adapters with captured official formats, lifecycle recovery with injected failures,
and the public dispatch boundary with authorization and scope cases. Live acceptance
requires the Tokyo2070 Blender outputs on both chosen standard environments.
GPU training is not an acceptance prerequisite for this CPU trial, and remains
unsupported until a standard-hosted GPU capability is actually verified. The 51
focused tests passed; full Cc regression and live provider execution are unperformed.

## Inputs needed before committing to a runtime adapter

1. Execution scope is settled: both standard-hosted environments only.
2. Resolve actual Codex/Claude environment IDs and account access. For Codex, verify
   whether the installed cloud CLI controls the intended published environment.
3. Choose the permitted source/artifact transfer route and retention location.
4. Claude needs an existing routine configured for standard hosting, a fire token
   stored through the approved secret mechanism, and a saved prompt accepting the
   job packet. Environment names/availability were asked about and remain unanswered.
5. Obtain the referenced local-only Claude commit if it is to be reused; it cannot
   be fetched by guessing a branch that has not been published.

Normal delegation API, WebUI and MCP integration, private S3 transfer and operator
reference reconciliation are implemented. Account/environment/storage configuration
and real capability evidence remain pending. The intent journal intentionally
blocks replay after incomplete writes or missing receipts. Operator reconciliation
records a provider reference only; it does not prove remote completion or cancellation.
Do not delete an ambiguous intent to retry. A provider receipt means submitted,
and verified bytes mean received: neither means model acceptance or task done.

2026-10-16 preflight: `codex cloud list --json --limit 1` returned Not signed in.
No submission was attempted. Actual Codex environment selection, Claude routine,
secret binding, and private artifact destination remain unconfirmed. The running
Cc service is unchanged. Local tests use injected provider transports, not cloud
accounts. Official CLI output contract was additionally checked in OpenAI's
`codex-rs/cloud-tasks/src/lib.rs` (`run_exec_command`) and `util.rs` (`task_url`):
https://github.com/openai/codex/tree/main/codex-rs/cloud-tasks/src

Claude `auth status` reports loggedIn=true / claude.ai; this proves local account
login only, not a configured standard-hosted routine or its fire-token binding.
`codex login status` still reports Not logged in. No cloud/S3 configuration variable
names were present in the current session environment. This is not a claim that
no configuration exists anywhere else or that either account lacks the product.

## Verification record

- 2026-10-16 initial isolated implementation: 51 tests passed. Covers admission bounds,
  blocked prerequisites, concurrent duplicate submission, transport ambiguity,
  receipt-write failure, persisted partial intents, provider response validation,
  and missing/corrupt/wrong-source/wrong-attempt artifacts.
- Runtime integration: 90 focused cloud/API/MCP tests passed, including the
  launch-budget boundary. Existing delegation service/queue/API regressions:
  75 passed. Web tests: 5 passed (new cloud controls plus existing spawn form).
- Backend production and web TypeScript checks and Vite production build passed.
  Global test TypeScript check failed on 15 diagnostics in unchanged fixture files;
  tracked as Actio `f47d9c8e-2cae-4aa9-825a-5702deadff0a` via bug-report. Do not
  present this global check as successful. The new module focused typecheck passed.
  Initial missing dependency resolution was corrected using the existing main
  checkout's Vitest types; a widened mock literal was fixed with an explicit type.
- `git diff --check` passed. Cc testing claims were released successfully.
- No service started/restarted, no full Cc regression, no PR review, no merge,
  no live cloud task, no Blender output, and no game integration performed.
- Actio `actio:b0483e60-297d-4dc6-a4bf-54e1f8752e04` is delegated to the current
  session; instruction links include implementation/Tokyo2070 trial and Fg/LD.
  Do not mark this task done while review/release and live acceptance are outstanding.
