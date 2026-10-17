import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactIngressSettings } from "./artifact-ingress-server.js";

describe("Tailscale-only receiver configuration", () => {
  const env = { CONCORDIA_ARTIFACT_ROOT: resolve("artifact"), CONCORDIA_ARTIFACT_PORT: "11114" };
  it("uses a discovered local Tailscale address", () => {
    expect(artifactIngressSettings(env, () => "100.100.1.2")).toEqual({ root: env.CONCORDIA_ARTIFACT_ROOT, host: "100.100.1.2", port: 11114 });
  });
  it.each([null, "127.0.0.1", "0.0.0.0", "192.168.1.2"])("fails closed without Tailscale: %s", host => {
    expect(() => artifactIngressSettings(env, () => host)).toThrow();
  });
  it.each(["", "80", "65536", "11114junk"])("requires explicit valid port: %s", port => {
    expect(() => artifactIngressSettings({ ...env, CONCORDIA_ARTIFACT_PORT: port }, () => "100.100.1.2")).toThrow();
  });
});
