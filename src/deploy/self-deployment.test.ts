import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SqliteDeploymentLedger } from "./service-deployed-runtime.js";
import { reportSelfDeployment, SELF_SERVICE_CODE, startSelfDeploymentReport } from "./self-deployment.js";

describe("reportSelfDeployment", () => {
  const base = { version: "2.4.0", startedAt: "2026-10-06T00:00:00.000Z" };

  it("runs the deployment handling once when the running version changed", async () => {
    const handle = vi.fn(async () => undefined);
    await expect(reportSelfDeployment({ ...base, currentHash: "3d60b715eac5", previousHash: "35ecbbaf2f87", handle })).resolves.toBe(true);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      code: SELF_SERVICE_CODE, previousHash: "35ecbbaf2f87", currentHash: "3d60b715eac5", restartCount: 0,
    }));
  });

  it("does nothing for the same version (short hashes of different length) or when it cannot compare", async () => {
    const handle = vi.fn(async () => undefined);
    await expect(reportSelfDeployment({ ...base, currentHash: "3d60b715eac5", previousHash: "3d60b71", handle })).resolves.toBe(false);
    await expect(reportSelfDeployment({ ...base, currentHash: null, previousHash: "35ecbbaf2f87", handle })).resolves.toBe(false);
    await expect(reportSelfDeployment({ ...base, currentHash: "3d60b715eac5", previousHash: null, handle })).resolves.toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it("reads the latest version a service was deployed at from the ledger", () => {
    const ledger = new SqliteDeploymentLedger(makeTestDb());
    expect(ledger.latestHash("concordia")).toBeNull();
    ledger.claim("concordia", "35ecbbaf2f87");
    ledger.claim("glab", "e601e4d791e5");
    expect(ledger.latestHash("concordia")).toBe("35ecbbaf2f87");
  });

  it("reports after the delay and can be stopped before it fires", async () => {
    vi.useFakeTimers();
    try {
      const handle = vi.fn(async () => undefined);
      const log = { info: vi.fn(), warn: vi.fn() };
      const deps = { latestHash: () => "35ecbbaf2f87", readHead: async () => "3d60b715eac5", version: "2.4.0", handle, log, delayMs: 100 };
      startSelfDeploymentReport(deps).stop();
      const running = startSelfDeploymentReport(deps);
      await vi.advanceTimersByTimeAsync(150);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("reported"));
      running.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
