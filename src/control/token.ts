/**
 * Spawn-endpoint token. Concordia generates a 64-hex token at startup
 * (if absent) and stores it in its working directory (next to `concordia.db`).
 * Callers wishing to invoke `POST /v1/spawn` must read the file and send
 * the value as `Authorization: Bearer <token>`.
 *
 * Storage in cwd (rather than ~/.concordia) matches the project rule of
 * "user home を汚さない" — see shared/config.ts:defaultDbPath().
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { platform } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_FILENAME = ".spawn.token";

export function spawnTokenPath(cwd: string = process.cwd()): string {
  // Allow override via env so docker / systemd deployments can place the
  // token on a volume separate from cwd.
  return process.env.CONCORDIA_SPAWN_TOKEN_PATH ?? join(cwd, DEFAULT_FILENAME);
}

export function ensureSpawnToken(cwd: string = process.cwd()): string {
  const path = spawnTokenPath(cwd);
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(t)) return t;
    // corrupt — rotate
  }
  mkdirSync(dirname(path), { recursive: true });
  const fresh = randomBytes(32).toString("hex");
  writeFileSync(path, fresh, "utf8");
  if (platform() !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
  }
  return fresh;
}

export function readSpawnToken(cwd: string = process.cwd()): string | null {
  const path = spawnTokenPath(cwd);
  try {
    if (!existsSync(path)) return null;
    const t = readFileSync(path, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Constant-time hex comparison. Both strings must be valid 64-hex. */
export function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  if (provided.length !== expected.length) return false;
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, "hex");
    b = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Parse `Authorization: Bearer ...` or `X-Concordia-Token: ...`. */
export function extractBearer(headerGet: (name: string) => string | undefined | null): string | null {
  const auth = headerGet("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const x = headerGet("x-concordia-token");
  if (x) return x.trim();
  return null;
}
