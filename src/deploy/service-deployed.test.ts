import { describe, expect, it, vi } from "vitest";
import { composeDeploymentNotice, handleServiceDeployment, type DeploymentDelivery } from "./service-deployed.js";

const event = { code: "Cc", previousHash: "1234567old", currentHash: "7654321new", version: "1.2.3", startedAt: "2026-09-11T00:00:00.000Z", restartCount: 1 };
const delivery: DeploymentDelivery = { discord: vi.fn(), slack: vi.fn(), ccChannel: vi.fn(), subsidiaryChannel: vi.fn() };

describe("service deployed notification", () => {
  it("C-1 suppresses the duplicate event before delivery", async () => {
    const result = await handleServiceDeployment({ event, ledger: { claim: () => false }, lookup: { findProject: () => null, changes: async () => null }, delivery });
    expect(result).toEqual({ duplicate: true, delivered: [], failed: [], fallback: false });
  });

  it("still notifies HQ when the service has no project registry row", async () => {
    const hqDelivery: DeploymentDelivery = { discord: vi.fn(), slack: vi.fn(), ccChannel: vi.fn(), subsidiaryChannel: vi.fn() };
    const result = await handleServiceDeployment({
      event: { ...event, code: "genius" },
      ledger: { claim: () => true },
      lookup: { findProject: () => null, changes: async () => null, hqTargets: () => [{ kind: "cc-channel", target: "" }] },
      delivery: hqDelivery,
    });
    expect(result.fallback).toBe(true);
    expect(result.delivered).toEqual([{ target: { kind: "cc-channel", target: "" } }]);
    expect(hqDelivery.ccChannel).toHaveBeenCalledWith(expect.stringContaining("[genius] デプロイ反映"));
  });

  it("delivers to a subsidiary channel without a subsidiary bot token (runtime falls back to the HQ bot)", async () => {
    const subDelivery: DeploymentDelivery = { discord: vi.fn(), slack: vi.fn(), ccChannel: vi.fn(), subsidiaryChannel: vi.fn() };
    const result = await handleServiceDeployment({
      event,
      ledger: { claim: () => true },
      lookup: { findProject: () => ({ repo_origin: null, deploy_notify: [{ kind: "subsidiary-channel", target: "123", subsidiaryId: "sub-1", botTokenEnc: null }] }), changes: async () => null },
      delivery: subDelivery,
    });
    expect(result.failed).toEqual([]);
    expect(subDelivery.subsidiaryChannel).toHaveBeenCalledWith("123", null, expect.stringContaining("デプロイ反映"));
  });

  it("C-2 falls back to deployment-only wording when Revisor is unavailable", () => {
    expect(composeDeploymentNotice(event, null)).toContain("反映のみ");
  });

  it("C-3 dispatches every configured delivery kind", async () => {
    const result = await handleServiceDeployment({ event, ledger: { claim: () => true }, lookup: { findProject: () => ({ repo_origin: null, deploy_notify: [{ kind: "discord", target: "discord-hook" }, { kind: "slack", target: "slack-hook" }, { kind: "cc-channel", target: "" }] }), changes: async () => null }, delivery });
    expect(result.delivered).toHaveLength(3);
    expect(delivery.discord).toHaveBeenCalled();
    expect(delivery.slack).toHaveBeenCalled();
    expect(delivery.ccChannel).toHaveBeenCalledWith(expect.not.stringContaining("<@"));
  });

  it("records a failed destination while continuing the remaining deliveries", async () => {
    const failingDelivery: DeploymentDelivery = {
      discord: vi.fn(async () => { throw new Error("webhook rejected"); }),
      slack: vi.fn(),
      ccChannel: vi.fn(),
      subsidiaryChannel: vi.fn(),
    };
    const result = await handleServiceDeployment({ event, ledger: { claim: () => true }, lookup: { findProject: () => ({ repo_origin: null, deploy_notify: [{ kind: "discord", target: "discord-hook" }, { kind: "slack", target: "slack-hook" }] }), changes: async () => null }, delivery: failingDelivery });
    expect(result.delivered).toEqual([{ target: { kind: "slack", target: "slack-hook" } }]);
    expect(result.failed).toEqual([{ target: { kind: "discord", target: "discord-hook" }, error: "webhook rejected" }]);
    expect(failingDelivery.slack).toHaveBeenCalledOnce();
  });
});
