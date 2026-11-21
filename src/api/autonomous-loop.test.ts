import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { CircuitBreakerRepository } from "../management/circuit-breaker-repo.js";
import { CircuitBreakerService } from "../management/circuit-breaker-service.js";
import { autonomousLoopRouter } from "./autonomous-loop.js";

const BASE = "/v1/autonomous-loop/circuit-breaker";
const run = { run_id: "integrate-81", project_code: "Cf", target_key: "variant/1" };

function appFixture() {
  const breaker = new CircuitBreakerService(new CircuitBreakerRepository(makeTestDb()), {
    now: () => 100, isCostBlocked: () => false, countManagedRuns: () => 0,
    postAlert: async () => false, sessionLink: () => null,
  });
  const app = new Hono();
  app.route("/v1/autonomous-loop", autonomousLoopRouter(breaker));
  return (method: string, route = "", body?: unknown) => app.request(`${BASE}${route}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("autonomous loop breaker HTTP boundary", () => {
  it("blocks check while manually tripped, still accepts results, then resumes on reset", async () => {
    const call = appFixture();
    expect(await (await call("GET")).json()).toMatchObject({ breaker: { status: "CLOSED" } });
    expect((await call("POST", "/check", run)).status).toBe(200);
    expect(await (await call("POST", "/trip")).json()).toMatchObject({ breaker: { status: "OPEN", reason: "manual" } });
    const blocked = await call("POST", "/check", { ...run, run_id: "another" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "circuit_breaker_open" });
    expect((await call("POST", "/success", { run_id: run.run_id })).status).toBe(200);
    expect((await call("POST", "/failure", { run_id: run.run_id })).status).toBe(409);
    expect(await (await call("POST", "/reset")).json()).toMatchObject({ breaker: { status: "CLOSED" } });
    expect((await call("POST", "/check", { ...run, run_id: "another" })).status).toBe(200);
  });

  it("validates configuration without partially applying a rejected patch", async () => {
    const call = appFixture();
    expect((await call("PATCH", "/config", { consecutive_failures: 1, concurrency_limit: 0 })).status).toBe(400);
    expect(await (await call("GET")).json()).toMatchObject({ breaker: { config: { consecutive_failures: 3 } } });
    expect((await call("PATCH", "/config", { unexpected: 1 })).status).toBe(400);
    expect((await call("PATCH", "/config", { consecutive_failures: 1, cooldown_ms: 500 })).status).toBe(200);
    await call("POST", "/check", run);
    const result = await call("POST", "/failure", { run_id: run.run_id, session_id: "sess-x" });
    expect(await result.json()).toMatchObject({ breaker: { status: "OPEN", reason: "consecutive_failures", target: { session_id: "sess-x" } } });
    expect((await call("POST", "/failure", { run_id: "absent" })).status).toBe(404);
  });
});
