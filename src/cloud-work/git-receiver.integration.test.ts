import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCloudGit } from "./git-process.js";
import { GitRunGrants } from "./git-run-grant.js";
import { CloudGitReceiver } from "./git-receiver.js";

describe("real Git binary return", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  it("receives a descendant commit in isolation without changing source checkout", async () => {
    root = await mkdtemp(join(tmpdir(), "cc-git-wire-"));
    const source = join(root, "source");
    await mkdir(source);
    await runCloudGit(source, ["init", "--initial-branch=main", "."]);
    await runCloudGit(source, ["config", "user.name", "Cloud test"]);
    await runCloudGit(source, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(source, "README.md"), "source\n");
    await runCloudGit(source, ["add", "README.md"]);
    await runCloudGit(source, ["commit", "-m", "source"]);
    const sourceRevision = (await runCloudGit(source, ["rev-parse", "HEAD"])).toString("utf8").trim();
    const grants = new GitRunGrants(join(root, "returns"));
    const { grant } = await grants.issue({ targetId: "target", attemptId: "run", repositoryKey: "repo", provider: "codex-cloud",
      sourceRevision, issuedAt: 1, expiresAt: 5000, maxPackBytes: 100_000 });
    const directory = grants.directory("target", "run"), receiver = new CloudGitReceiver();
    await receiver.prepare(directory, source, grant);
    expect((await receiver.advertise(directory, grant)).toString("utf8")).toContain("# service=git-receive-pack");
    await writeFile(join(source, "model.bin"), Buffer.from([0, 255, 13, 10, 128]));
    await runCloudGit(source, ["add", "model.bin"]);
    await runCloudGit(source, ["commit", "-m", "model"]);
    const oid = (await runCloudGit(source, ["rev-parse", "HEAD"])).toString("utf8").trim();
    const pack = await runCloudGit(source, ["pack-objects", "--stdout", "--revs"], Buffer.from(`${oid}\n^${sourceRevision}\n`, "utf8"));
    const line = `${"0".repeat(40)} ${oid} ${grant.ref}\0report-status`;
    const body = Buffer.concat([Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`, "utf8"), pack]);
    const result = await receiver.receive(directory, grant, body);
    expect(result.toString("utf8")).toContain(`ok ${grant.ref}`);
    expect((await receiver.result(directory))?.oid).toBe(oid);
    expect(await receiver.receive(directory, grant, body)).toEqual(result);
    expect((await runCloudGit(source, ["branch", "--show-current"])).toString("utf8").trim()).toBe("main");
    expect(await runCloudGit(join(directory, "receive.git"), ["show", `${grant.ref}:model.bin`])).toEqual(Buffer.from([0, 255, 13, 10, 128]));
  }, 30_000);
});
