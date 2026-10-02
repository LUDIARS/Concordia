import { normalizeRepoOrigin } from "./normalize.js";

/** @implements CC-RV-LIST-SCOPE-01 */
/** C-4: a branch match keeps the repository and the case-sensitive branch identity (empty head refs never match). */
export default {
  post(result: unknown, _rows?: unknown, repository?: unknown, branch?: unknown): boolean {
    if (result === null) return true;
    if (!result || typeof result !== "object" || typeof repository !== "string" || typeof branch !== "string") return false;
    const row = result as { repository?: unknown; headRef?: unknown };
    return typeof row.repository === "string"
      && normalizeRepoOrigin(row.repository).toLowerCase() === normalizeRepoOrigin(repository).toLowerCase()
      && row.headRef === branch
      && branch !== "";
  },
};
