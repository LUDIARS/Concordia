import type { CloudSubmission } from "./submission.js";

/** Shared identity travels with the task, not with provider-specific secrets. */
export function cloudProviderPrompt(request: CloudSubmission): string {
  return [
    "Execute this authorized cloud work packet in the configured standard hosted environment.",
    "Verify git HEAD equals sourceRevision before work; stop and report any mismatch.",
    "Do not open a PR, provision compute, or use an external runner. Never push to GitHub. Push only if the private transfer instructions explicitly authorize a designated Git return URL and ref.",
    "Preserve artifacts through the preconfigured private transfer route. Report errors honestly.",
    JSON.stringify({ attemptId: request.attemptId, taskReference: request.taskReference,
      sourceRevision: request.sourceRevision, instruction: request.instruction }),
  ].join("\n");
}
