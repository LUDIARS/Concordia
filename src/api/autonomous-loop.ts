import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { BreakerConfig, BreakerTarget } from "../management/circuit-breaker.js";
import type { CircuitBreakerService } from "../management/circuit-breaker-service.js";
import { ManagementInputError, optionalKey, requireKey, requireProject } from "../management/domain.js";

const PATH = "/circuit-breaker";
const CONFIG_LIMITS = {
  consecutive_failures: 1000,
  target_oscillation: 1000,
  concurrency_limit: 1000,
  trigger_rate_limit: 1000,
  cooldown_ms: 7 * 24 * 60 * 60_000,
} satisfies Record<keyof BreakerConfig, number>;

export function autonomousLoopRouter(service: CircuitBreakerService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (c.get("concordiaWebIdentity")) return c.json({ error: "local_only" }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ManagementInputError) return c.json({ error: error.code, message: error.message }, 400);
    throw error;
  });
  app.use("*", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "payload_too_large" }, 413) }));

  app.get(PATH, (c) => c.json({ breaker: service.snapshot() }));
  app.post(`${PATH}/check`, async (c) => {
    const body = await readObject(c);
    const result = service.check(requireKey(body.run_id, "run_id"), readTarget(body));
    if ("error" in result) return c.json(result, 409);
    if (result.breaker.status === "OPEN") return c.json({ ...result, error: "circuit_breaker_open" }, 409);
    return c.json(result);
  });
  for (const outcome of ["failure", "success"] as const) {
    app.post(`${PATH}/${outcome}`, async (c) => {
      const body = await readObject(c);
      const result = service.report(requireKey(body.run_id, "run_id"), outcome, optionalKey(body.session_id, "session_id"));
      if ("error" in result) return c.json(result, result.error === "run_not_found" ? 404 : 409);
      return c.json(result);
    });
  }
  app.post(`${PATH}/trip`, async (c) => {
    const body = await readObject(c, true);
    return c.json({ breaker: service.trip(Object.keys(body).length === 0 ? null : readTarget(body)) });
  });
  app.post(`${PATH}/reset`, (c) => c.json({ breaker: service.reset() }));
  app.patch(`${PATH}/config`, async (c) => c.json({ breaker: service.configure(readConfig(await readObject(c))) }));
  return app;
}

async function readObject(c: Context, allowEmpty = false): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (allowEmpty && raw.length === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ManagementInputError("invalid_body", "JSON object が必要です"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManagementInputError("invalid_body", "JSON object が必要です");
  }
  return parsed as Record<string, unknown>;
}

function readTarget(body: Record<string, unknown>): BreakerTarget {
  return {
    project_code: requireProject(body.project_code),
    target_key: requireKey(body.target_key, "target_key"),
    session_id: optionalKey(body.session_id, "session_id"),
  };
}

function readConfig(body: Record<string, unknown>): Partial<BreakerConfig> {
  const config: Partial<BreakerConfig> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(CONFIG_LIMITS, key)) throw new ManagementInputError("invalid_config", `未知の設定項目です ${key}`);
    const field = key as keyof BreakerConfig;
    if (field === "cooldown_ms" && value === null) {
      config.cooldown_ms = null;
      continue;
    }
    const max = CONFIG_LIMITS[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new ManagementInputError("invalid_config", `${field} は 1〜${max} の整数です`);
    }
    config[field] = value;
  }
  return config;
}
