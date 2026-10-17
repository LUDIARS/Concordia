import { describe, expect, it, vi } from "vitest";
import { preflightCloudTarget, createCloudWorkRuntime } from "./runtime.js";
import { cloudTargetFixture } from "../../tests/helpers/cloud-target-fixture.js";
import type { TaskStore } from "../taskflow/store.js";

describe("cloud runtime preflight", () => {
  it("refuses a changed published revision before checking or starting cloud work", async () => {
    const run = vi.fn(async () => `${"b".repeat(40)}\trefs/heads/main\n`);
    await expect(preflightCloudTarget(cloudTargetFixture(), run)).rejects.toThrow("cloud_published_source_unverified");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("requires authenticated Codex access without submitting a task", async () => {
    const run = vi.fn(async () => `${"a".repeat(40)}\trefs/heads/main\n`);
    run.mockResolvedValueOnce(`${"a".repeat(40)}\trefs/heads/main\n`).mockRejectedValueOnce(new Error("Not signed in"));
    await expect(preflightCloudTarget(cloudTargetFixture(), run)).rejects.toThrow("codex_cloud_access_unverified");
    expect(run).toHaveBeenLastCalledWith("codex.exe", ["cloud", "list", "--env", "test-env", "--json", "--limit", "1"], "repo-a");
  });
  it("mounts safely without configuration or creating provider work", async () => {
    const runtime = createCloudWorkRuntime({ root: "unused", tasks: {} as TaskStore, env: {} });
    expect(await runtime.availability({ repositoryKey: "repo-a", subsidiaryId: null })).toEqual([]);
  });
});
