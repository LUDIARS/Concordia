// Async replacements for the sync fs probes the runtime paths used to call
// (spec/tasks/full-async-io.md). Keep the semantics of the sync originals so
// callers can swap them without changing behaviour.

// node:fs's promises namespace (not the node:fs/promises module) so a test that
// replaces node:fs/promises with a partial mock cannot change this probe.
import { promises as fsPromises } from "node:fs";

/** Async `existsSync`: true when the path can be accessed, false on any error. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await fsPromises.access(path);
    return true;
  } catch {
    return false;
  }
}
