import { normalizeRepoOrigin } from "./normalize.js";

/** @implements CC-RV-OPEN-LIST-01 */
/** C-1: submission matching keeps only open PRs of the target repository (never every repository). */
export default {
  post(result: unknown, repository?: unknown): boolean {
    if (!Array.isArray(result)) return false;
    if (typeof repository !== "string" || !repository.trim()) return result.length === 0;
    const key = normalizeRepoOrigin(repository).toLowerCase();
    return result.every((row: { status?: unknown; repository?: unknown }) =>
      row.status === "open"
      && typeof row.repository === "string"
      && normalizeRepoOrigin(row.repository).toLowerCase() === key);
  },
};
