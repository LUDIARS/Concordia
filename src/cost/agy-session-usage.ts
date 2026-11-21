import { join } from "node:path";
import type { SessionRow } from "../shared/types.js";
import { AGY_CONVERSATIONS, agyBindingsForSession, trustedAgyPath } from "./agy-usage-binding.js";
import { agyUsageDatabase } from "./agy-usage-database.js";
import type { AgyGeneration } from "./agy-usage-metadata.js";
import { agySessionGenerations } from "./agy-usage-policy.js";
import type { UsagePoint } from "./usage-timeline.js";

type SessionGeneration = AgyGeneration & { conversationId: string };

export async function readAgySessionGenerations(
  session: SessionRow,
  root = AGY_CONVERSATIONS,
): Promise<SessionGeneration[]> {
  if (session.provider !== "antigravity-cli") return [];
  const end = session.ended_at === null ? Infinity : session.ended_at * 1000;
  const generations: SessionGeneration[] = [];
  const ids = new Set<string>();
  for (const binding of agyBindingsForSession(session)) {
    if (ids.has(binding.id)) continue;
    ids.add(binding.id);
    const path = await trustedAgyPath(join(root, binding.id + ".db"), root);
    if (!path) continue;
    const snapshot = await agyUsageDatabase.read(path);
    if (snapshot) {
      for (const row of agySessionGenerations(snapshot.rows, binding.startedAtMs, end)) {
        generations.push({ ...row, conversationId: binding.id });
      }
    }
  }
  return generations.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

export function agyUsagePoints(generations: readonly SessionGeneration[]): UsagePoint[] {
  return generations.flatMap((row, index) => {
    if (row.atMs === null) return [];
    const next = generations[index + 1];
    const turnEnd = row.turnIndex !== null && next?.turnIndex != null
      && (next.turnIndex !== row.turnIndex || next.conversationId !== row.conversationId);
    return [{ atMs: row.atMs, tokens: row.total, ...(turnEnd ? { turnEnd } : {}) }];
  });
}
