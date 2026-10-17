import { describe, expect, it } from "vitest";
import { CloudTargetSchema, CloudEnvironmentSchema, resolveCloudWork, cloudTargetReady, readCloudTargets } from "./runtime-config.js";
import { cloudTargetFixture } from "../../tests/helpers/cloud-target-fixture.js";

describe("cloud target configuration", () => {
  it("allows environment setup without fixing the next job's revision or output", () => {
    const fixture = cloudTargetFixture();
    const { sourceRevision, repositoryBytes, expectedNames, maxArtifactBytes, preparationEvidence, verifiedAt, ...environment } = fixture;
    expect(CloudEnvironmentSchema.safeParse(environment).success).toBe(true);
    expect(() => resolveCloudWork(environment)).toThrow("cloud_work_plan_required_or_invalid");
    expect(resolveCloudWork(environment, { sourceRevision, repositoryBytes, expectedNames: ["new-render.png"],
      maxArtifactBytes, preparationEvidence, verifiedAt }).expectedNames).toEqual(["new-render.png"]);
  });
  it("defaults to Git, requires its binding, and does not silently select S3", () => {
    const value = { ...cloudTargetFixture(), transferMode: undefined, storage: undefined,
      git: { publicHost: "git.example.com", accessHeaderEnv: "CLOUD_ACCESS", accessHeaderName: "X-Cloud-Access" } };
    const target = CloudTargetSchema.parse(value);
    expect(target.transferMode).toBe("git");
    expect(cloudTargetReady(target, { CLOUD_ACCESS: "test" }, Date.parse(target.verifiedAt))).toBe(true);
    expect(CloudTargetSchema.safeParse({ ...cloudTargetFixture(), transferMode: undefined }).success).toBe(false);
  });
  it("is unavailable when not configured", async () => { expect(await readCloudTargets(undefined)).toEqual([]); });
  it("requires fresh evidence and secret bindings", () => {
    const target = cloudTargetFixture(), now = Date.parse(target.verifiedAt);
    expect(cloudTargetReady(target, { TEST_ACCESS: "test", TEST_SECRET: "test" }, now)).toBe(true);
    expect(cloudTargetReady(target, {}, now)).toBe(false);
    expect(cloudTargetReady(target, { TEST_ACCESS: "test", TEST_SECRET: "test" }, now + 86_400_001)).toBe(false);
    expect(cloudTargetReady(target, { TEST_ACCESS: "test", TEST_SECRET: "test" }, now - 1)).toBe(false);
  });
  it.each([{ standardHosted: false }, { repositoryBytes: 50_000_001 }, { codexExecutable: "codex.cmd" },
    { sourceRevision: "main" }, { requiresLargeProjectClone: true }, { expectedNames: ["../secret"] },
    { expectedNames: ["result.json"] }, { expectedNames: ["scene.blend", "scene.blend"] },
    { provider: "claude-cloud" }])("rejects unsafe or incomplete configuration: %j", patch => {
      expect(CloudTargetSchema.safeParse({ ...cloudTargetFixture(), ...patch }).success).toBe(false);
    });
});
