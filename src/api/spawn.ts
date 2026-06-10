/**
 * /v1/spawn — orchestrator endpoint. Spawns a new lictor-wrapped Claude
 * Code / Codex session in a Windows Terminal tab or window.
 *
 * Auth: Bearer token from `<cwd>/.spawn.token` (`Authorization: Bearer ...`
 * or `X-Concordia-Token: ...`). `GET /v1/spawn/info` (no auth) returns the
 * absolute path of the token file so callers can locate it without knowing
 * Concordia's cwd in advance.
 *
 * Concurrency is bounded by Windows Terminal itself; Concordia keeps the
 * last 50 spawn records in memory for debugging via `GET /v1/spawn/recent`.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  buildWtArgs,
  isSpawnProvider,
  resolveSpawnCwd,
  spawnSession,
  SPAWN_PROVIDERS,
  type SpawnMode,
  type SpawnRequest,
} from "../control/spawner.js";
import {
  ensureSpawnToken,
  extractBearer,
  spawnTokenPath,
  tokenMatches,
} from "../control/token.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("api/spawn");

export interface SpawnApiDeps {
  /** cwd Concordia was started in — used for token storage. */
  cwd?: string;
  /**
   * Default working directory the spawn endpoint applies when the caller
   * omits `cwd` (e.g. CONCORDIA_SPAWN_DEFAULT_CWD=E:\Document\Ars). Empty
   * or non-existent path = no fallback (Concordia's own cwd is used).
   */
  defaultSpawnCwd?: string;
  /**
   * 日次トークン予算を超過している間 true を返す。 true の間は spawn を 429 で
   * 拒否する (Concordia 発の新規セッション起動を止める)。 未指定なら無効。
   */
  isCostBlocked?: () => boolean;
}

export interface SpawnRecord {
  id: string;
  ts: string;
  request: SpawnRequest;
  command: string[];
  pid: number | null;
}

const RECENT_CAP = 50;

export function spawnRouter(deps: SpawnApiDeps = {}): Hono {
  const app = new Hono();
  const cwd = deps.cwd ?? process.cwd();
  const expectedToken = ensureSpawnToken(cwd);
  const records: SpawnRecord[] = [];

  log.info({ tokenPath: spawnTokenPath(cwd) }, "spawn endpoint enabled");

  // No-auth: where to find the token + the default cwd UI will pre-fill.
  // (We don't return the token VALUE — only the path so callers can find it.)
  app.get("/info", (c) => {
    return c.json({
      token_path: spawnTokenPath(cwd),
      platform_supported: process.platform === "win32",
      default_cwd: deps.defaultSpawnCwd ?? "",
    });
  });

  app.use("*", async (c, next) => {
    // /info is the only no-auth route; it's matched above before this hits.
    const provided = extractBearer((name) => c.req.header(name) ?? undefined);
    if (!provided || !tokenMatches(expectedToken, provided)) {
      return c.json({ error: "missing or invalid token" }, 401, {
        "www-authenticate": 'Bearer realm="concordia-spawn"',
      });
    }
    await next();
  });

  app.post("/", async (c) => {
    // 日次トークン予算を超過している間は新規セッション起動を拒否する。
    if (deps.isCostBlocked?.()) {
      return c.json(
        { error: "cost budget exceeded — daily token budget reached, spawn blocked" },
        429,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const provider = (body.provider as string) ?? "claude";
    if (!isSpawnProvider(provider)) {
      return c.json(
        { error: `unknown provider: ${provider} (valid: ${SPAWN_PROVIDERS.join(", ")})` },
        400,
      );
    }
    const mode: SpawnMode = body.mode === "window" ? "window" : "tab";
    const request: SpawnRequest = {
      provider,
      mode,
      args: Array.isArray(body.args)
        ? (body.args as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined,
      cwd: resolveSpawnCwd(body.cwd, deps.defaultSpawnCwd),
      title: typeof body.title === "string" ? body.title : undefined,
      // env は外部入力からは受け取らない (CWE-78 RCE 対策)。 spawn child に渡る env は
      // Concordia 内部が設定する allowlist key のみ (spawner.sanitizeSpawnEnv)。
    };

    const result = spawnSession(request);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    const record: SpawnRecord = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      request,
      command: result.command,
      pid: result.pid,
    };
    records.push(record);
    if (records.length > RECENT_CAP) records.splice(0, records.length - RECENT_CAP);
    log.info({ id: record.id, provider, mode, pid: record.pid }, "spawn launched");
    return c.json({ ok: true, id: record.id, pid: record.pid, command: result.command });
  });

  app.get("/recent", (c) => {
    return c.json({ spawns: records.slice() });
  });

  // Dry-run for the same payload shape — useful for UI previews.
  app.post("/preview", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const provider = (body.provider as string) ?? "claude";
    if (!isSpawnProvider(provider)) {
      return c.json(
        { error: `unknown provider: ${provider} (valid: ${SPAWN_PROVIDERS.join(", ")})` },
        400,
      );
    }
    const mode: SpawnMode = body.mode === "window" ? "window" : "tab";
    const args = buildWtArgs({
      provider,
      mode,
      args: Array.isArray(body.args)
        ? (body.args as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined,
      cwd: resolveSpawnCwd(body.cwd, deps.defaultSpawnCwd),
      title: typeof body.title === "string" ? body.title : undefined,
    });
    return c.json({ command: ["wt.exe", ...args] });
  });

  return app;
}
