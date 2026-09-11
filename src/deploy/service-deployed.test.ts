import { describe, expect, it, vi } from "vitest";
import { composeDeploymentNotice, handleServiceDeployment, type DeploymentDelivery } from "./service-deployed.js";

const event = { code: "Cc", previousHash: "1234567old", currentHash: "7654321new", version: "1.2.3", startedAt: "2026-09-11T00:00:00.000Z", restartCount: 1 };
const delivery: DeploymentDelivery = { discord: vi.fn(), slack: vi.fn(), ccChannel: vi.fn() };

describe("service deployed notification", () => {
  it("C-1 suppresses the duplicate event before delivery", async () => {
    const result = await handleServiceDeployment({ event, ledger: { claim: () => false }, lookup: { findProject: () => null, changes: async () => null }, delivery });
    expect(result).toEqual({ duplicate: true, delivered: 0, fallback: false });
  });

  it("C-2 falls back to deployment-only wording when Revisor is unavailable", () => {
    expect(composeDeploymentNotice(event, null)).toContain("反映のみ");
  });

  it("C-3 dispatches every configured delivery kind", async () => {
    const result = await handleServiceDeployment({ event, ledger: { claim: () => true }, lookup: { findProject: () => ({ repo_origin: null, deploy_notify: [{ kind: "discord", target: "discord-hook" }, { kind: "slack", target: "slack-hook" }, { kind: "cc-channel", target: "" }] }), changes: async () => null }, delivery });
    expect(result.delivered).toBe(3);
    expect(delivery.discord).toHaveBeenCalled();
    expect(delivery.slack).toHaveBeenCalled();
    expect(delivery.ccChannel).toHaveBeenCalledWith(expect.not.stringContaining("<@"));
  });
});
