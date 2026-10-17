import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudGitReturn } from "./git-return.js";
import { cloudTargetFixture } from "../../tests/helpers/cloud-target-fixture.js";
import { cloudSubmissionFixture } from "../../tests/helpers/cloud-submission-fixture.js";

describe("Git return and local review", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cc-return-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function fixture(reviewResult: unknown = { pullRequest: { id: "pr", number: 1, status: "open" } }) {
    const target = { ...cloudTargetFixture(), transferMode: "git" as const,
      git: { publicHost: "git.example.com", accessHeaderEnv: "ACCESS", accessHeaderName: "X-Access" } };
    const request = cloudSubmissionFixture();
    const command = vi.fn(async (_cwd: string, args: string[]) => Buffer.from(args[0] === "rev-parse" ? target.sourceRevision
      : args[0] === "ls-tree" ? `100644 blob ${"a".repeat(40)} 5\tscene.blend\0` : ""));
    const review = vi.fn(async () => reviewResult);
    const service = new CloudGitReturn(root, { ACCESS: "private-header" }, async () => "repo", review, command, () => 1000);
    const prompt = await service.instructions(target, request);
    const directory = join(root, target.id, request.attemptId);
    await writeFile(join(directory, "received.json"), JSON.stringify({ requestHash: "a".repeat(64), oid: "b".repeat(40), response: "" }));
    return { target, request, command, review, service, directory, prompt };
  }
  it("provides one transient credential without placing it in the URL or disk", async () => {
    const { prompt, directory } = await fixture();
    const capability = JSON.parse(prompt.split("\n").at(-1)!);
    expect(capability.url).toMatch(/^https:\/\/git.example.com\/git\//);
    expect(capability.url).not.toContain(capability.token);
    expect(await readFile(join(directory, "grant.json"), "utf8")).not.toContain(capability.token);
  });
  it("promotes only a new ref and submits local review once", async () => {
    const { service, target, request, review, command } = await fixture();
    await expect(service.collect(target, request.attemptId)).resolves.toMatchObject({ state: "review_submitted" });
    await expect(service.collect(target, request.attemptId)).resolves.toMatchObject({ state: "review_submitted" });
    expect(review).toHaveBeenCalledOnce();
    expect(command.mock.calls.some(([, args]) => args[0] === "update-ref" && args[3] === "0".repeat(40))).toBe(true);
    expect(command.mock.calls.some(([, args]) => args.includes("push"))).toBe(false);
  });
  it("does not claim a rejected review is submitted", async () => {
    const { service, target, request, review } = await fixture({ submitted: false, reason: "error" });
    await expect(service.collect(target, request.attemptId)).resolves.toMatchObject({ state: "review_submission_unconfirmed" });
    await service.collect(target, request.attemptId);
    expect(review).toHaveBeenCalledOnce();
  });
  it("keeps lost review replies unknown and never resends", async () => {
    const { service, target, request, review } = await fixture();
    review.mockRejectedValueOnce(new Error("lost reply"));
    await expect(service.collect(target, request.attemptId)).rejects.toThrow("lost reply");
    await expect(service.collect(target, request.attemptId)).rejects.toThrow("cloud_git_review_unknown");
    expect(review).toHaveBeenCalledOnce();
  });
});
