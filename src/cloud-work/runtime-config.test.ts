import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudTargetSchema, CloudEnvironmentSchema, resolveCloudWork, cloudTargetReady, readCloudTargets, driveArtifactNames } from "./runtime-config.js";
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
  it("returns non-code outputs through Drive beside Git and requires the Drive secrets for readiness", () => {
    const drive = { folderId: "folder_0123456789", clientIdEnv: "G_ID", clientSecretEnv: "G_SECRET", refreshTokenEnv: "G_REFRESH" };
    const git = { publicHost: "git.example.com", accessHeaderEnv: "CLOUD_ACCESS", accessHeaderName: "X-Cloud-Access" };
    const target = CloudTargetSchema.parse({ ...cloudTargetFixture(), transferMode: "git", storage: undefined, git, drive,
      expectedNames: ["model.py"], driveExpectedNames: ["scene.blend", "preview.png"] });
    expect(driveArtifactNames(target)).toEqual(["scene.blend", "preview.png"]);
    const now = Date.parse(target.verifiedAt);
    expect(cloudTargetReady(target, { CLOUD_ACCESS: "a" }, now)).toBe(false);
    expect(cloudTargetReady(target, { CLOUD_ACCESS: "a", G_ID: "i", G_SECRET: "s", G_REFRESH: "r" }, now)).toBe(true);
    const driveOnly = CloudTargetSchema.parse({ ...cloudTargetFixture(), transferMode: "drive", storage: undefined, drive });
    expect(driveArtifactNames(driveOnly)).toEqual(["scene.blend"]);
  });
  it.each([
    { transferMode: "drive", storage: undefined },
    { driveExpectedNames: ["preview.png"] },
    { transferMode: "git", git: { publicHost: "git.example.com", accessHeaderEnv: "A", accessHeaderName: "X-A" },
      drive: { folderId: "folder_0123456789", clientIdEnv: "G_ID", clientSecretEnv: "G_SECRET", refreshTokenEnv: "G_REFRESH" },
      driveExpectedNames: ["scene.blend"] },
  ])("rejects incomplete or overlapping Drive transfer: %j", patch => {
    expect(CloudTargetSchema.safeParse({ ...cloudTargetFixture(), ...patch }).success).toBe(false);
  });
  it("is unavailable when not configured", async () => { expect(await readCloudTargets(undefined)).toEqual([]); });
  it("treats a not-yet-created file as no targets and gives Claude the default environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-cloud-config-"));
    try {
      expect(await readCloudTargets(join(root, "cloud-targets.json"))).toEqual([]);
      const { environmentId, codexExecutable, ...rest } = cloudTargetFixture();
      await writeFile(join(root, "cloud-targets.json"), JSON.stringify([{ ...rest, provider: "claude-cloud", claudeExecutable: "claude.exe", claudeTriggerId: "trig_1", claudeTokenEnv: "TOKEN" }]));
      expect((await readCloudTargets(join(root, "cloud-targets.json")))[0].environmentId).toBe("claude-default");
      await writeFile(join(root, "codex.json"), JSON.stringify([{ ...rest, codexExecutable }]));
      await expect(readCloudTargets(join(root, "codex.json"))).rejects.toThrow("cloud_configuration_invalid");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
