import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { AGY_CONVERSATIONS, trustedAgyPath } from "./agy-usage-binding.js";
import { agyUsageDatabase, type AgyUsageSnapshot } from "./agy-usage-database.js";

const MAX_DATABASES_PER_SAMPLE = 128;
const MAX_DIRECTORY_ENTRIES = 4096;

export interface AgyBudgetObservation {
  path: string;
  lastIndex: number;
  rows: AgyUsageSnapshot["rows"];
}

/** Global budget includes local agy calls with or without a Cc session. */
export async function* readRecentAgyBudgetUsage(
  maxAgeMs: number,
  now: number,
  root = AGY_CONVERSATIONS,
): AsyncGenerator<AgyBudgetObservation> {
  const dir = await opendir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!dir) return;
  let observed = 0;
  let scanned = 0;
  for await (const entry of dir) {
    if (++scanned > MAX_DIRECTORY_ENTRIES) return;
    if (!entry.isFile()) continue;
    const path = await trustedAgyPath(join(root, entry.name), root);
    if (!path) continue;
    const snapshot = await agyUsageDatabase.read(path, now - maxAgeMs);
    if (!snapshot) continue;
    if (snapshot.lastIndex !== null) yield { path, lastIndex: snapshot.lastIndex, rows: snapshot.rows };
    if (++observed >= MAX_DATABASES_PER_SAMPLE) return;
  }
}
