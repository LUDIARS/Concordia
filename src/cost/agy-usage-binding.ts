import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import type { SessionRow } from "../shared/types.js";

export const AGY_CONVERSATIONS = join(homedir(), ".gemini", "antigravity-cli", "conversations");
export const AGY_USAGE_BINDINGS = "agy_usage_bindings";
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const MAX_BINDINGS = 64;

export interface AgyUsageBinding {
  id: string;
  startedAtMs: number;
}

export function agyBindings(value: unknown): AgyUsageBinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_BINDINGS).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, startedAtMs } = entry as Partial<AgyUsageBinding>;
    return typeof id === "string" && UUID.test(id) && typeof startedAtMs === "number"
        && Number.isSafeInteger(startedAtMs) && startedAtMs > 0
      ? [{ id: id.toLowerCase(), startedAtMs }] : [];
  });
}

export function rememberAgyBinding(value: unknown, binding: AgyUsageBinding): AgyUsageBinding[] {
  const existing = agyBindings(value);
  return existing.some(({ id }) => id === binding.id)
    ? existing : [...existing, binding].slice(-MAX_BINDINGS);
}

export function agyBindingsForSession(session: SessionRow): AgyUsageBinding[] {
  try {
    const meta = JSON.parse(session.metadata ?? "{}") as Record<string, unknown> | null;
    return agyBindings(meta?.[AGY_USAGE_BINDINGS]);
  } catch {
    return [];
  }
}

export async function trustedAgyPath(path: string, root = AGY_CONVERSATIONS): Promise<string | null> {
  if (!isAbsolute(path) || !path.endsWith(".db") || !UUID.test(basename(path, ".db"))) return null;
  try {
    const [local, directory, info] = await Promise.all([realpath(path), realpath(root), lstat(path)]);
    return info.isFile() && relative(directory, local) === basename(path) ? local : null;
  } catch {
    return null;
  }
}
