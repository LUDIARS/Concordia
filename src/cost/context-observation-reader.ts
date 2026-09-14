import { open } from "node:fs/promises";
import type { SessionRow } from "../shared/types.js";
import { resolveSessionTranscript } from "./log-usage.js";
import { contextObservationFromLines, type ContextObservation } from "./context-observation.js";

const TAIL_BYTES = 1024 * 1024;
const CACHE_ENTRIES = 128;
const cache = new Map<string, { signature: string; value: ContextObservation | null }>();
const inflight = new Map<string, Promise<ContextObservation | null>>();

/** At most 1 MiB per changed transcript; unchanged files reuse the parsed observation. */
async function readObservation(path: string, provider: string): Promise<ContextObservation | null> {
  const key = `${provider}:${path}`;
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const signature = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = cache.get(key);
    if (cached?.signature === signature) return cached.value;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(stat.size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8", 0, bytesRead);
    // Discard incomplete boundary records; never parse a guessed/truncated JSON object.
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    const lines = text.split(/\r?\n/);
    lines.pop();
    const value = contextObservationFromLines(lines, provider);
    cache.delete(key);
    cache.set(key, { signature, value });
    if (cache.size > CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return value;
  } finally {
    await file.close();
  }
}

export async function readSessionContextObservation(
  session: SessionRow,
  resolveTranscript: (session: SessionRow) => Promise<string | null> = resolveSessionTranscript,
): Promise<ContextObservation | null> {
  const path = await resolveTranscript(session);
  if (!path) return null;
  const key = `${session.provider}:${path}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = readObservation(path, session.provider).catch(() => {
    // A deleted/unreadable log is an unknown observation, never a reason to scan other files.
    return null;
  }).finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}
