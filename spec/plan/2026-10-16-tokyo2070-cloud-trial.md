# Tokyo2070 hosted Blender modelling trial

Status: prepared test brief, NOT dispatched or modelled. Human instruction on
2026-10-16 authorizes implementation if feasible and Tokyo2070 modelling as the test.

## Input and scope

- Candidate source: Tokyo2070 revision `2041a75ff2a67529ff2e790e466f449906260de7`.
- Read-only Git measurement: 304 objects reachable from that revision, 649,267
  uncompressed bytes, largest object 48,376 bytes. HEAD files total 479,986 bytes.
  This is this revision's ancestry, not all remote refs or downloaded city assets.
  Verify the actual provider clone scope before asserting the <=50MB admission.
- Do not transfer `assets/cities`, the roughly 100MB city dataset, or build the full
  Emscripten application. No sibling repositories or external GPU workers.
- Model an original small street terminal suitable for the overgrown future Tokyo
  setting. This is a trial proposal inferred from the existing game setting, not
  an approved final art direction or an asset already integrated into the game.
- Both providers use the same brief, independently. Keep outputs and attempt IDs
  separate. Do not silently run locally when a cloud environment is unavailable.

## Agent brief

Create a weathered street information terminal for a deserted Tokyo street in 2070.
Use a roughly 1.8m-tall metal body, a recessed dark display, a broken canopy edge,
and small ivy clusters growing around the base and one side. Keep the silhouette
readable at game distance; avoid logos, real personal data and external textures.
Use Blender procedural meshes/materials, metric scale, object origins at ground
level, meaningful object names, and a modest game-ready triangle count (<=20,000).

The cloud LLM should choose the detailed proportions and placement, write or adapt
the Blender script, render a preview, inspect it, and make at most one correction
if geometry or framing is visibly wrong. A predetermined local script alone is
not evidence that LLM-guided cloud modelling succeeded.

Use CPU Cycles for this bounded trial: 512x512, 16 samples, seed 42. Limit each
Blender invocation to 180 seconds and the whole job to 15 minutes. Report timeout
as an interruption, not success or proof of remote cancellation. GPU availability
is not assumed, and GPU-required training remains outside verified capability.

Deliver `scene.blend`, `terminal.glb`, `preview.png`, `model.py`, and `run.log`.
Reopen the saved blend in background mode and confirm named mesh objects and
triangle count. Record Blender version, device, dimensions, triangle count,
source revision and actual execution environment in the log. Export GLB without
camera/lights and verify that it can be imported into a fresh scene.

Default Git route: commit all five outputs at repository root and push only the
allocated new ref to the private Cc receiver using the transient run capability.
Never push to GitHub, publish assets, or create a GitHub PR. Disable existing
remote push destinations before work. Return the accepted commit identity.
For an explicitly selected S3 target only, upload outputs then write `result.json`
last: `{version:1, attemptId, sourceRevision, status:"completed", artifacts:[{name,bytes,sha256}]}`.
Never include signed URLs or access tokens in the log, source, commit or manifest.
Failed/missing output is not a completed manifest. Never fall back between routes.

## Acceptance and current blockers

1. Gate all four human eligibility conditions using actual preparation evidence.
2. Preserve a remote task/session ID and prove the run took place on the selected
   standard hosted environment; a unit test or local Blender run is not a substitute.
3. Retrieve all five files and validate the attempt/source identity, sizes and
   SHA-256 values. Inspect the preview and independently reopen/import the assets.
4. Record modelling result separately from human art acceptance and game integration.
5. Repeat on the second provider; do not count one provider's success for both.

Current preflight: `codex cloud list --json --limit 1` returned **Not signed in**.
On 2026-10-17, `codex login status` still reports **Not logged in** and Tokyo2070
HEAD is still the candidate revision above. Existing untracked `.anatomia/` and
`spec/data/` were left untouched. No configured cloud binding names were present
in this session's environment; service-owned bindings have not been verified.
No cloud task was submitted. The hosted environment selection, Claude routine and
its secret binding, published input revision, and private artifact destination
remain unverified. Existing questions about environment availability are unanswered.
