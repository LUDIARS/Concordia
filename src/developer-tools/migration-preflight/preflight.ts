import { compareMigrations, type MigrationCollision, type MigrationDefinition } from "./compare.js";
import { parseMigrations } from "./parse.js";

export interface MigrationRef { ref: string; sha: string }
export interface MigrationRepository {
  resolve(ref: string): string;
  unmergedBranches(mainSha: string): MigrationRef[];
  mergeBase(leftSha: string, rightSha: string): string;
  schema(sha: string): string;
}
export interface MigrationPreflightReport {
  target: MigrationRef;
  comparisons: Array<MigrationRef & { ancestor: string; collisions: MigrationCollision[] }>;
}

/** Pin refs once; abort the whole report if any required read cannot be interpreted. */
export function preflightMigrations(repository: MigrationRepository, ref = "HEAD"): MigrationPreflightReport {
  const target = { ref, sha: repository.resolve(ref) };
  const main = { ref: "refs/heads/main", sha: repository.resolve("refs/heads/main") };
  const cache = new Map<string, MigrationDefinition[]>();
  const read = (sha: string): MigrationDefinition[] => {
    const found = cache.get(sha);
    if (found) return found;
    try {
      const parsed = parseMigrations(repository.schema(sha));
      cache.set(sha, parsed);
      return parsed;
    } catch (error) {
      throw new Error(`schema at ${sha}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const left = read(target.sha);
  const refs = [main, ...repository.unmergedBranches(main.sha)];
  const comparisons = refs.filter(peer => peer.sha !== target.sha).map(peer => {
    const ancestor = repository.mergeBase(target.sha, peer.sha);
    return { ...peer, ancestor, collisions: compareMigrations(left, read(peer.sha), read(ancestor)) };
  });
  return { target, comparisons };
}
