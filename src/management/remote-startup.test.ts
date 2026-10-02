import { describe, expect, it, vi } from "vitest";
import type { ManagementService } from "./service.js";
import { startManagementRemote } from "./remote-startup.js";

const service = {} as ManagementService;
const env = { CONCORDIA_MANAGEMENT_LISTEN: "1", CONCORDIA_MANAGEMENT_LISTEN_PORT: "11113" };

describe("dots remote entrance lifecycle (CC-MGMT-07)", () => {
  it("does nothing when disabled", async () => {
    const start = vi.fn();
    await startManagementRemote({}, service, start).stop();
    expect(start).not.toHaveBeenCalled();
  });

  it("reports a bad config instead of failing Cc startup", async () => {
    const report = vi.fn();
    const start = vi.fn();
    await startManagementRemote({ CONCORDIA_MANAGEMENT_LISTEN: "1" }, service, start, report).stop();
    expect(start).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("management", expect.stringContaining("設定が不正"));
  });

  it("reports a listen failure and still stops cleanly", async () => {
    const report = vi.fn();
    const runtime = startManagementRemote(env, service, vi.fn(async () => { throw new Error("EADDRINUSE"); }), report);
    await runtime.stop();
    expect(report).toHaveBeenCalledWith("management", expect.stringContaining("EADDRINUSE"));
  });

  it("closes the listener on stop even when stop is called during startup", async () => {
    const close = vi.fn(async () => {});
    let finish!: () => void;
    const start = vi.fn(() => new Promise<{ host: string; port: number; close: () => Promise<void> }>((resolve) => {
      finish = () => resolve({ host: "127.0.0.1", port: 11113, close });
    }));
    const runtime = startManagementRemote(env, service, start);
    const stopping = runtime.stop();
    finish();
    await stopping;
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("public access not yet configured (CC-MGMT-08)", () => {
  it("still starts the Tailscale side and reports that the public side is closed", async () => {
    const report = vi.fn();
    const close = vi.fn(async () => {});
    const start = vi.fn(async () => ({ host: "127.0.0.1", port: 11113, close }));
    const runtime = startManagementRemote({ ...env, CONCORDIA_MANAGEMENT_PUBLIC_HOST: "cdgd-mgmt.ai-run-do.com" }, service, start, report);
    await runtime.stop();
    expect(start).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith("management", expect.stringContaining("全て拒否"));
  });
});
