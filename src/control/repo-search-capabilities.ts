// @spec CC-REPO-SEARCH-01
import { classifyRepositorySearch, formatRepositorySearchGuidance, type RepositorySearchCapabilities, type RepositorySearchSnapshot } from "./repo-search-policy.js";
import { readRepositorySearchSnapshot, repositorySearchIdentity } from "./repo-search-snapshot.js";

export interface RepositorySearchPort {
  identity(root: string): Promise<string>;
  inspect(root: string, provider: string): Promise<RepositorySearchSnapshot>;
  now(): number;
}

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 64;
const MAX_INFLIGHT = 4;
const INSPECTION_TIMEOUT_MS = 5_000;

/** Coalesce bounded host inspections; key by registered root, provider, and checkout identity. */
export function createRepositorySearchService(port: RepositorySearchPort) {
  const cache = new Map<string, { value: RepositorySearchCapabilities; expires: number }>();
  const inflight = new Map<string, Promise<RepositorySearchCapabilities>>();
  return async (root: string, provider: string): Promise<RepositorySearchCapabilities> => {
    const key = `${await port.identity(root)}\0${provider}`;
    const stored = cache.get(key);
    if (stored && stored.expires > port.now()) return stored.value;
    const pending = inflight.get(key);
    if (pending) return pending;
    if (inflight.size >= MAX_INFLIGHT) throw new Error("repository search inspection capacity reached");
    const work = port.inspect(root, provider).then((snapshot) => {
      const value = classifyRepositorySearch(snapshot);
      cache.set(key, { value, expires: port.now() + TTL_MS });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      return value;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("repository search inspection timed out")), INSPECTION_TIMEOUT_MS);
    });
    const bounded = Promise.race([work, deadline]).finally(() => { if (timeout) clearTimeout(timeout); });
    inflight.set(key, bounded);
    // A timed-out underlying I/O still occupies a slot until it settles.
    void work.finally(() => { inflight.delete(key); }).catch(() => {});
    return bounded;
  };
}

const inspect = createRepositorySearchService({ identity: repositorySearchIdentity, inspect: readRepositorySearchSnapshot, now: Date.now });

export async function repositorySearchGuidance(root: string, provider: string): Promise<string> {
  return formatRepositorySearchGuidance(await inspect(root, provider));
}
