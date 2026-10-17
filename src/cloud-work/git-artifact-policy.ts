/** Verify configured output files from Git's NUL-delimited tree listing, without checkout. */
export function verifyGitArtifactTree(listing: Buffer, expectedNames: readonly string[], maxBytes: number): void {
  const files = new Map<string, { mode: string; size: number }>();
  for (const entry of listing.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) blob [a-f0-9]{40,64} +([0-9]+)\t([^\0]+)$/.exec(entry);
    if (!match) throw new Error("cloud_git_artifact_tree_invalid");
    const name = match[3]!, size = Number(match[2]);
    if (!Number.isSafeInteger(size) || files.has(name)) throw new Error("cloud_git_artifact_tree_invalid");
    files.set(name, { mode: match[1]!, size });
  }
  let total = 0;
  for (const name of expectedNames) {
    const file = files.get(name);
    if (!file || !["100644", "100755"].includes(file.mode)) throw new Error("cloud_git_artifact_missing_or_not_regular");
    total += file.size;
    if (total > maxBytes) throw new Error("cloud_git_artifact_too_large");
  }
}
