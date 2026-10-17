import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCloudSubmissionStore } from "./file-submission-store.js";
import { cloudSubmissionFixture } from "../../tests/helpers/cloud-submission-fixture.js";

describe("durable cloud submission intents", () => {
  it("reserves once across store instances and preserves receipts independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-cloud-test-"));
    try {
      const a = new FileCloudSubmissionStore(root);
      const b = new FileCloudSubmissionStore(root);
      expect((await Promise.all([a.reserve(cloudSubmissionFixture()), b.reserve(cloudSubmissionFixture())])).sort()).toEqual([false, true]);
      expect(JSON.parse(await readFile(join(root, "tokyo2070-1.intent.json"), "utf8"))).toEqual(cloudSubmissionFixture());
      await a.recordReceipt("tokyo2070-1", { state: "submission_unknown" });
      await expect(b.reserve(cloudSubmissionFixture())).resolves.toBe(false);
      await expect(b.recordReceipt("tokyo2070-1", { state: "submitted", remoteId: "new" })).rejects.toMatchObject({ code: "EEXIST" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("treats an interrupted partial intent as reserved, never as permission to resend", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-cloud-test-"));
    try {
      await writeFile(join(root, "tokyo2070-1.intent.json"), "{partial");
      await expect(new FileCloudSubmissionStore(root).reserve(cloudSubmissionFixture())).resolves.toBe(false);
      await expect(new FileCloudSubmissionStore(root).reserve({ ...cloudSubmissionFixture(), attemptId: "../escape" })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
