import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { readBranchSnapshot } from "../harness/reliability/task-branch-git.js";
import { readWorkingBranch } from "./session-skill-source.js";
import type { DeclaredTargetIo } from "./session-working-repo.js";

/** decideDeclaredTargetPatch の実 I/O (ローカル checkout の .git と git branch)。 */
export const localDeclaredTargetIo: DeclaredTargetIo = {
  repoKey: mainRepositoryKey,
  currentBranch: readWorkingBranch,
  checkoutBranches: async (path) => {
    try { return ((await readBranchSnapshot(path)).checkouts ?? []).map((checkout) => checkout.branch); }
    catch { return null; }
  },
};
