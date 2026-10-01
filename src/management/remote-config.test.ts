import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { findTailscaleAddress, isTailscaleAddress, readManagementRemoteConfig } from "./remote-config.js";

function nic(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: "IPv4", internal, netmask: "255.255.255.255", mac: "00:00:00:00:00:00", cidr: null };
}

const interfaces = () => ({ lo: [nic("127.0.0.1", true)], eth: [nic("192.168.1.5")], ts: [nic("100.101.102.103")] });

describe("dots remote entrance config (CC-MGMT-07)", () => {
  it("is off unless explicitly enabled", () => {
    expect(readManagementRemoteConfig({})).toBeNull();
    expect(readManagementRemoteConfig({ CONCORDIA_MANAGEMENT_LISTEN: "0", CONCORDIA_MANAGEMENT_LISTEN_PORT: "11113" })).toBeNull();
  });

  it("requires a port when enabled and defaults the host to loopback", () => {
    expect(() => readManagementRemoteConfig({ CONCORDIA_MANAGEMENT_LISTEN: "1" })).toThrow(/requires CONCORDIA_MANAGEMENT_LISTEN_PORT/);
    expect(readManagementRemoteConfig({ CONCORDIA_MANAGEMENT_LISTEN: "1", CONCORDIA_MANAGEMENT_LISTEN_PORT: "11113" }))
      .toEqual({ host: "127.0.0.1", port: 11113 });
  });

  it("resolves the tailscale keyword to this PC's 100.64.0.0/10 address", () => {
    const env = { CONCORDIA_MANAGEMENT_LISTEN: "1", CONCORDIA_MANAGEMENT_LISTEN_PORT: "11113", CONCORDIA_MANAGEMENT_LISTEN_HOST: "tailscale" };
    expect(readManagementRemoteConfig(env, interfaces)).toEqual({ host: "100.101.102.103", port: 11113 });
    expect(() => readManagementRemoteConfig(env, () => ({ eth: [nic("192.168.1.5")] }))).toThrow(/no Tailscale/);
  });

  it("recognises only the CGNAT range as Tailscale", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.254")).toBe(true);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("10.0.0.1")).toBe(false);
    expect(findTailscaleAddress(() => ({ ts: [nic("100.100.100.100", true)] }))).toBeNull();
  });
});
