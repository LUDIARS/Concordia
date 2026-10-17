# Standard cloud setup and recovery

This is operator configuration, not a record of completed setup. No live target or
storage has been configured by this change. No extra cloud compute is provisioned.

## Prerequisites

1. Select an existing standard hosted Codex environment and an existing standard
   hosted Claude routine. Verify Blender installation/preparation and network access
   to the selected Git ingress (default) or private S3 bucket (explicit). Claude's saved routine prompt must
   authorize executing the fire text as the work packet. Never substitute a Platform
   inference API key for a routine fire token.
2. Sign in to ChatGPT using the Codex CLI account that runs the Cc service. Use the
   actual native executable path on Windows, not the `.cmd` package wrapper.
   Check `codex cloud list --env <id> --json --limit 1`. CLI presence alone is not
   authenticated environment access or proof of compatibility with a new cloud product.
3. For an explicitly selected S3 target, use an existing private AWS S3 bucket and a least-privilege identity for its
   designated prefix (`GetObject`/`PutObject`, no public ACL). Configure retention
   with the storage owner. This feature does not create or change buckets or IAM.
4. Store credentials through the approved service secret bindings. The JSON file
   contains variable names only. The remote agent receives one-hour single-object
   PUT capabilities with overwrite prevention; long-lived AWS keys stay local.
5. Measure the actual provider checkout (Git history, LFS/submodules and required
   dependency clone scope), ensure <=50,000,000 bytes, and verify environment setup.
   Record the measurement and preparation in `preparationEvidence`. Recheck within
   24 hours and for each changed source revision. Never use HEAD file size alone.

## Configuration

2026-10-17 correction: operator setup identifies the provider environment and private transport,
not a permanently fixed modelling job. `sourceRevision`, `repositoryBytes`, `preparationEvidence`,
`verifiedAt`, `expectedNames`, and `maxArtifactBytes` may be omitted from target configuration.
The calling Cc agent supplies those fields as `work` on each API/MCP submission after inspecting
that request. The exact plan is frozen in the intent; later collection uses that snapshot.
Changing a plan under the same attempt ID is rejected. Legacy fully specified targets still work.
The Web form does not yet prepare this per-run plan automatically; API/MCP are the current entry
points for targets without fixed job fields. Do not ask the operator to invent future output names.

### Git default

Omitting `transferMode` means `git`, never S3. Configure separate target IDs when offering both routes.
For Git, omit `storage` and supply `git: { publicHost, accessHeaderEnv, accessHeaderName }`.
`accessHeaderName` is an explicitly configured `X-...` Cloudflare Access single-header service-token name;
`accessHeaderEnv` resolves its secret value through service bindings. The Basic Authorization header
is reserved for the per-run token. No credential is placed in a URL or persisted in the grant journal.

The separate `concordia-cloud-git` Excubitor service runs only from the main Concordia folder after review.
It binds loopback port 11114 (catalog owner). Before enabling it, bind these settings:

- `CONCORDIA_CLOUD_GIT_ROOT`: absolute private directory, **same value on backend and ingress**;
  otherwise backend uses `<Cc DB directory>/cloud-work/git-return`. Never use a repository or synced folder.
- `CONCORDIA_CLOUD_GIT_PUBLIC_HOST`: approved dedicated hostname, also used in each Git target.
- `CONCORDIA_CLOUD_GIT_ACCESS_TEAM` and `CONCORDIA_CLOUD_GIT_ACCESS_AUD`: exact Access application issuer/audience.
- `CONCORDIA_CLOUD_GIT_PORT`: catalog supplies 11114.

Tunnel only this listener to the approved hostname; keep Access mandatory. Do not tunnel the regular
Cc/Revisor APIs. Provider network policy must allow this hostname. Check both providers' actual Git
HTTPS header behavior before a trial; writing these settings is not proof of access or successful delivery.
Launch/stop through Excubitor with Cc testing claim. No service starts automatically from this change.

Git collection confirms received commit ancestry, imports objects locally, creates the assigned fresh
branch without overwriting another branch, and uses the existing direct local PR submission path.
`review_submitted` is not acceptance or deployment. `review_submission_unconfirmed` and
`cloud_git_review_unknown` require inspection of the saved intent and existing PR, never resubmission.
Interrupted receive or promotion retains the isolated repository and journals for operator reconciliation.
There is no automatic unlock/retry mechanism. S3 configuration below remains an explicit alternative.

### Optional S3 target

Set `CONCORDIA_CLOUD_CONFIG_FILE` to an operator-owned UTF-8 JSON array outside the
repository. Cc reads it for each operation. Each target must specify:

```json
[
  {
    "id": "tokyo2070-codex",
    "label": "Tokyo2070 / Codex Cloud",
    "repoPath": "E:/Document/Ars/Tokyo2070",
    "subsidiaryId": null,
    "provider": "codex-cloud",
    "environmentId": "REPLACE_WITH_REAL_ENVIRONMENT_ID",
    "standardHosted": true,
    "publishedBranch": "main",
    "sourceRevision": "REPLACE_WITH_EXACT_PUBLISHED_COMMIT",
    "repositoryBytes": 0,
    "preparationEvidence": "REPLACE_WITH_MEASUREMENT_AND_SETUP_EVIDENCE",
    "verifiedAt": "REPLACE_WITH_CURRENT_VERIFIED_ISO_TIMESTAMP",
    "environmentPreparable": true,
    "requiresLargeProjectClone": false,
    "gpuVerified": false,
    "codexExecutable": "REPLACE_WITH_NATIVE_CODEX_EXECUTABLE_PATH",
    "expectedNames": ["scene.blend", "terminal.glb", "preview.png", "model.py", "run.log"],
    "maxArtifactBytes": 50000000,
    "transferMode": "s3",
    "storage": {
      "bucket": "REPLACE_WITH_EXISTING_PRIVATE_BUCKET",
      "region": "ap-northeast-1",
      "prefix": "cc-cloud",
      "accessKeyEnv": "CC_CLOUD_S3_ACCESS_KEY_ID",
      "secretKeyEnv": "CC_CLOUD_S3_SECRET_ACCESS_KEY"
    }
  }
]
```

The placeholders deliberately fail validation. Replace `repositoryBytes: 0` with
the measured amount; zero in this example is not evidence. For a Claude target,
use another target `id`, `provider: "claude-cloud"`, its real environment ID,
`claudeTriggerId` (`trig_...`) and `claudeTokenEnv` (the bound variable name);
omit `codexExecutable`. Optional `storage.sessionTokenEnv` supports temporary AWS
credentials. An expired credential or stale preparation evidence is not readiness.

Use the Delegation page or `delegation_cloud_work` MCP tool. Select the parent
session in the target repository and an accessible existing Actio task. Supply
the actual heavy-compute and LLM-guidance reasons, and whether GPU is mandatory.
Tokyo2070, Synergos, Fg and LD are examples, never permanent allowlist entries.
The API lives at `/v1/delegation/cloud` (targets; runs; run status; collect;
reconcile; verified artifact download). The MCP wrapper inherits session identity.

## Outcome and recovery

- The published branch is checked before launch, and the worker must compare
  its checkout to the recorded revision before any generation. A moving branch
  must fail the worker check, not quietly render another source revision.
- No automatic retries of submission, no implicit local fallback, and no automatic
  completion of the Actio task. An intent without a receipt is unknown.
- Keep the same attempt ID when inspecting a lost response. Locate the task on
  the provider's site; `reconcile` records the observed task/session ID once. That
  observation does not prove a remote state or cancel a task.
- The worker must upload all configured files followed by `result.json`. Use the
  manifest contract in the Tokyo2070 trial brief. Collection is explicit and may
  be retried without re-running the job. Signed URL expiration is not permission
  to launch another job. Expired upload capability currently needs operator recovery.
- Collection validates attempt/revision, file names, sizes and SHA-256 before the
  verified marker appears. Download checks the saved bytes again. Independently
  inspect and reopen Blender/GLB output; hash integrity does not prove model quality.
- Journal and received outputs live beside the configured Cc DB in `cloud-work`,
  partitioned by canonical repository and subsidiary. Preserve this directory.
  On corruption or a partial intent, reconcile; never delete an intent to retry.
- Disable `CONCORDIA_CLOUD_CONFIG_FILE` to stop new dispatch. Existing journals
  remain available for status; collection needs the original target/storage
  identity and secret bindings. No DB migration or local agent queue change.
- Local submission timeout does not cancel remote work. Cancellation/remote usage
  control remains in the provider UI. No standard-hosted GPU is assumed.

Reference contracts: official Codex `cloud exec` CLI and OpenAI cloud-tasks source;
Claude routines https://code.claude.com/docs/en/routines ; AWS query signing example
https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html
and conditional writes https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html .
