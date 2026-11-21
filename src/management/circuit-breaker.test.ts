import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { CircuitBreakerRepository } from "./circuit-breaker-repo.js";
import { CircuitBreakerService } from "./circuit-breaker-service.js";
import { TARGET_WINDOW_MS, TRIGGER_WINDOW_MS, formatBreakerAlert } from "./circuit-breaker.js";

const target = { project_code: "Cf", target_key: "variant/1", session_id: "s1" };

function setup() {
  let now = 2 * TARGET_WINDOW_MS;
  const repo = new CircuitBreakerRepository(makeTestDb());
  const postAlert = vi.fn(async (_text: string) => true);
  const isCostBlocked = vi.fn(() => false);
  const countManagedRuns = vi.fn(() => 0);
  const ports = { now: () => now, isCostBlocked, countManagedRuns, postAlert,
    sessionLink: () => "https://discord.com/channels/123/456/789" };
  return { service: new CircuitBreakerService(repo, ports), postAlert, isCostBlocked, countManagedRuns,
    restart: () => new CircuitBreakerService(repo, ports), advance: (ms: number) => { now += ms; } };
}

describe("autonomous loop breaker", () => {
  it("uses the existing global cost block to hold new starts", () => {
    const { service, isCostBlocked } = setup();
    isCostBlocked.mockReturnValue(true);
    expect(service.check("a", target)).toMatchObject({ breaker: { status: "OPEN", reason: "daily_cost_limit" } });
    expect(service.report("a", "success", null)).toEqual({ error: "run_not_found" });
  });

  it("stops after three consecutive failures, persists OPEN, and resets the streak on successful evaluation", () => {
    const { service, restart, advance } = setup();
    service.recordFailure(target);
    service.recordSuccess(target);
    service.recordFailure(target);
    service.recordFailure(target);
    expect(service.snapshot()).toMatchObject({ status: "CLOSED", consecutive_failures: 2 });
    service.recordFailure(target);
    advance(3 * TARGET_WINDOW_MS);
    expect(restart().snapshot()).toMatchObject({ status: "OPEN", reason: "consecutive_failures", target });
    expect(restart().reset()).toMatchObject({ status: "CLOSED", consecutive_failures: 0, reason: null });
  });

  it("scopes target counts to project and target and excludes starts outside the 30 minute window", () => {
    const { service, advance } = setup();
    service.check("expired", target);
    service.report("expired", "success", null);
    advance(TARGET_WINDOW_MS);
    expect(service.check("first", target)).toMatchObject({ breaker: { status: "CLOSED" } });
    expect(service.check("other-project", { ...target, project_code: "Di" })).toMatchObject({ breaker: { status: "CLOSED" } });
    expect(service.check("second", target)).toMatchObject({ breaker: { status: "CLOSED" } });
    expect(service.check("third", target)).toMatchObject({ breaker: { reason: "target_oscillation" } });
  });

  it("counts active managed and external runs together and keeps reservations through reset", () => {
    const { service, countManagedRuns } = setup();
    service.configure({ concurrency_limit: 2 });
    countManagedRuns.mockReturnValue(1);
    expect(service.check("first", target)).toMatchObject({ breaker: { status: "CLOSED" } });
    const claim = vi.fn(() => "claimed");
    expect(service.admitManaged({ ...target, target_key: "variant/2" }, claim)).toBeNull();
    expect(claim).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({ reason: "concurrency_limit" });
    service.reset();
    expect(service.check("second", { ...target, target_key: "variant/2" })).toMatchObject({ breaker: { reason: "concurrency_limit" } });
    expect(service.report("first", "success", null)).toMatchObject({ breaker: { status: "OPEN" } });
    service.reset();
    expect(service.admitManaged(target, claim)).toBe("claimed");
  });

  it("checks the trigger-rate window and counts each run once", () => {
    const { service, advance } = setup();
    service.configure({ trigger_rate_limit: 3 });
    service.check("expired", target);
    service.report("expired", "success", null);
    advance(TRIGGER_WINDOW_MS);
    for (const id of ["a", "b"]) {
      const runTarget = { ...target, target_key: id };
      expect(service.check(id, runTarget)).toMatchObject({ breaker: { status: "CLOSED" } });
      expect(service.check(id, runTarget)).toMatchObject({ breaker: { status: "CLOSED" } });
      expect(service.check(id, target)).toEqual({ error: "run_id_conflict" });
      expect(service.report(id, "failure", null)).toMatchObject({ breaker: { status: "CLOSED" } });
      expect(service.report(id, "failure", null)).toMatchObject({ breaker: { status: "CLOSED" } });
    }
    expect(service.check("c", { ...target, target_key: "c" })).toMatchObject({ breaker: { reason: "trigger_rate_limit" } });
  });

  it("reopens only after the configured cooldown and sends one alert per transition after a delivery retry", async () => {
    const { service, advance, postAlert } = setup();
    service.configure({ cooldown_ms: 1_000 });
    service.trip(target);
    service.trip({ ...target, target_key: "duplicate" });
    postAlert.mockResolvedValueOnce(false);
    await service.flushAlerts();
    await Promise.all([service.flushAlerts(), service.flushAlerts()]);
    await service.flushAlerts();
    expect(postAlert).toHaveBeenCalledTimes(2);
    expect(postAlert).toHaveBeenLastCalledWith(expect.stringContaining("https://discord.com/channels/123/456/789"));
    advance(999);
    expect(service.snapshot().status).toBe("OPEN");
    advance(1);
    expect(service.snapshot().status).toBe("CLOSED");
  });

  it("keeps mention and arbitrary link syntax out of alert text", () => {
    expect(formatBreakerAlert("manual", { ...target, target_key: "<@123> @everyone", session_id: "<@456>" }, "https://example.org/@here"))
      .not.toMatch(/@|https:\/\//);
  });
});
