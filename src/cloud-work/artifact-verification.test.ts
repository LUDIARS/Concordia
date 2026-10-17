import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCloudArtifacts } from "./artifact-verification.js";

function fixture() {
  const content = Buffer.from("BLENDER-test-fixture");
  const artifact = { name: "scene.blend", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
  return { manifest: { version: 1, attemptId: "trial-1", sourceRevision: "a".repeat(40), status: "completed", artifacts: [artifact] },
    attemptId: "trial-1", sourceRevision: "a".repeat(40), expectedNames: ["scene.blend"], maxTotalBytes: 1000,
    received: new Map([["scene.blend", content]]) };
}

describe("cloud artifact integrity", () => {
  it("reports integrity separately from task acceptance", () => {
    expect(verifyCloudArtifacts(fixture()).state).toBe("artifacts_verified");
  });
  it.each(["missing", "corrupt", "other-attempt", "other-source", "oversized", "path-traversal", "duplicate", "failed"])("rejects %s output", (kind) => {
    const input = fixture();
    if (kind === "missing") input.received.clear();
    if (kind === "corrupt") input.received.set("scene.blend", Buffer.alloc(input.manifest.artifacts[0].bytes));
    if (kind === "other-attempt") input.manifest.attemptId = "trial-2";
    if (kind === "other-source") input.manifest.sourceRevision = "b".repeat(40);
    if (kind === "oversized") input.maxTotalBytes = 1;
    if (kind === "path-traversal") input.manifest.artifacts[0].name = "../scene.blend";
    if (kind === "duplicate") input.manifest.artifacts.push(input.manifest.artifacts[0]);
    if (kind === "failed") input.manifest.status = "failed";
    expect(() => verifyCloudArtifacts(input)).toThrow();
  });
});
