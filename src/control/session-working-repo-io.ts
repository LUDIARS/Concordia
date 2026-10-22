import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { readWorkingBranch } from "./session-skill-source.js";
import type { DeclaredTargetIo } from "./session-working-repo.js";

/** decideDeclaredTargetPatch の実 I/O (ローカル checkout の .git と git branch)。 */
export const localDeclaredTargetIo: DeclaredTargetIo = {
  repoKey: mainRepositoryKey,
  currentBranch: readWorkingBranch,
};
