/**
 * /v1/spawn — orchestrator endpoint. Spawns a new lictor-wrapped Claude
 * Code / Codex session in a Windows Terminal tab or window.
 *
 * Auth: Bearer token from `<cwd>/.spawn.token` (`Authorization: Bearer ...`
 * or `X-Concordia-Token: ...`). `GET /v1/spawn/info` (no auth) returns the
 * absolute path of the token file so callers can locate it without knowing
 * Concordia's cwd in advance.
 *
 * Concurrency is bounded by Windows Terminal itself.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  isSpawnProvider,
  resolveAgentHomeCwd,
  resolveCastraDefaultCwd,
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
   * omits `cwd`. 既定はプライマリ workspace ルート (`workspaceRoots[0]`) を
   * 実行時に解決する resolver。 これにより設定 GUI / AdminState での上書きが
   * 即座に反映される (env 固定の spawnDefaultCwd を流用しない)。 空文字列を
   * 返す / 未指定なら fallback 無し (Concordia 自身の cwd で spawn)。
   */
  resolveDefaultCwd?: () => string;
  /**
   * 日次トークン予算を超過している間 true を返す。 true の間は spawn を 429 で
   * 拒否する (Concordia 発の新規セッション起動を止める)。 未指定なら無効。
   */
  isCostBlocked?: () => boolean;
}

export function spawnRouter(deps: SpawnApiDeps = {}): Hono {
  const app = new Hono();
  const cwd = deps.cwd ?? process.cwd();
  const expectedToken = ensureSpawnToken(cwd);

  log.info({ tokenPath: spawnTokenPath(cwd) }, "spawn endpoint enabled");

  // No-auth: where to find the token + the default cwd UI will pre-fill.
  // (We don't return the token VALUE — only the path so callers can find it.)
  app.get("/info", (c) => {
    return c.json({
      token_path: spawnTokenPath(cwd),
      platform_supported: process.platform === "win32",
      default_cwd: resolveCastraDefaultCwd(deps.resolveDefaultCwd?.()),
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
      cwd: resolveAgentHomeCwd(provider, body.cwd, deps.resolveDefaultCwd?.()),
      cwdProvided: typeof body.cwd === "string" && body.cwd.trim().length > 0,
      title: typeof body.title === "string" ? body.title : undefined,
      // env は外部入力からは受け取らない (CWE-78 RCE 対策)。 spawn child に渡る env は
      // Concordia 内部が設定する allowlist key のみ (spawner.sanitizeSpawnEnv)。
    };

    const result = spawnSession(request);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    const id = randomUUID();
    log.info({ id, provider, mode, pid: result.pid }, "spawn launched");
    return c.json({ ok: true, id, pid: result.pid, command: result.command });
  });

  return app;
}
