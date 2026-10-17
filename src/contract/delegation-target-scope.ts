/**
 * Whether the parent's work contract may shape a delegation at all.
 *
 * The contract (work_location / work_branch / model / effort) was decided for the work the
 * parent is doing in its own repository. When the caller explicitly points the delegation
 * at a directory outside that repository, applying it lands the child in the parent's
 * repository, on the parent's branch, with the parent's model (Actio 442bd0cc). An
 * explicit cwd elsewhere therefore opts the delegation out of the contract. Pure function.
 */
export function contractAppliesToDelegation(parentRepoPath: string | null | undefined, requestedCwd: string | null | undefined): boolean {
  const requested = normalize(requestedCwd);
  if (!requested) return true;
  const parent = normalize(parentRepoPath);
  if (!parent) return false;
  return requested === parent || requested.startsWith(`${parent}/`);
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
