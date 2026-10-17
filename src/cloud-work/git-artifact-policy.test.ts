import { describe, expect, it } from "vitest";
import { verifyGitArtifactTree } from "./git-artifact-policy.js";
const entry = (mode: string, size: number, name: string) => `${mode} blob ${"a".repeat(40)} ${size}\t${name}\0`;
describe("Git output inspection", () => {
  it("accepts regular named output within the combined budget", () => {
    expect(() => verifyGitArtifactTree(Buffer.from(entry("100644", 5, "scene.blend") + entry("100755", 5, "model.py")), ["scene.blend", "model.py"], 10)).not.toThrow();
  });
  it("rejects missing output", () => { expect(() => verifyGitArtifactTree(Buffer.alloc(0), ["scene.blend"], 10)).toThrow(); });
  it("rejects symbolic links even if their names match", () => { expect(() => verifyGitArtifactTree(Buffer.from(entry("120000", 5, "scene.blend")), ["scene.blend"], 10)).toThrow(); });
  it("rejects output exceeding its budget", () => { expect(() => verifyGitArtifactTree(Buffer.from(entry("100644", 11, "scene.blend")), ["scene.blend"], 10)).toThrow(); });
});
