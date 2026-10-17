import { describe, expect, it, vi } from "vitest";
import { readCloudResponse, S3CloudArtifacts } from "./artifact-transfer.js";
import { cloudTargetFixture } from "../../tests/helpers/cloud-target-fixture.js";

describe("private artifact transfer", () => {
  it("bounds response bytes and rejects HTTP failures", async () => {
    await expect(readCloudResponse(new Response("1234"), 3)).rejects.toThrow("cloud_artifact_too_large");
    await expect(readCloudResponse(new Response("error", { status: 403 }), 100)).rejects.toThrow();
  });
  it("uses separate attempt keys and never reveals the signing secret", () => {
    const adapter = new S3CloudArtifacts(cloudTargetFixture(), { TEST_ACCESS: "test-access", TEST_SECRET: "never-display-me" });
    const prompt = adapter.uploadInstructions("attempt-1");
    expect(prompt).toContain("/cloud-test/tokyo-codex/attempt-1/scene.blend");
    expect(prompt).toContain("if-none-match");
    expect(prompt).not.toContain("never-display-me");
    expect(() => adapter.uploadInstructions("../escape")).toThrow();
  });
  it("retrieves the manifest first, enforces total budget and disables redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ version: 1 }))
      .mockResolvedValueOnce(new Response("BLEND"));
    const adapter = new S3CloudArtifacts(cloudTargetFixture(), { TEST_ACCESS: "test", TEST_SECRET: "test" }, () => new Date(), fetcher);
    const result = await adapter.collect("attempt-1");
    expect(result.received.get("scene.blend")?.toString()).toBe("BLEND");
    expect(String(fetcher.mock.calls[0][0])).toContain("/result.json?");
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });
  it("redacts transport failures that include signed URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("https://secret?token=secret"));
    const adapter = new S3CloudArtifacts(cloudTargetFixture(), { TEST_ACCESS: "test", TEST_SECRET: "test" }, () => new Date(), fetcher);
    await expect(adapter.collect("attempt-1")).rejects.toThrow("cloud_artifact_collection_failed");
  });
});
