import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudGitReceiver } from "./git-receiver.js";
import type { GitRunGrant } from "./git-run-grant.js";

const grant: GitRunGrant = { targetId: "target", attemptId: "run", provider: "codex-cloud", repositoryKey: "repo",
  sourceRevision: "a".repeat(40), ref: "refs/heads/cloud/codex-cloud/run", tokenHash: "b".repeat(64),
  issuedAt: 1, expiresAt: 100, maxPackBytes: 1000 };
const oid = "c".repeat(40);
const line = `${"0".repeat(40)} ${oid} ${grant.ref}\0report-status`;
const body = Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000PACK`);

describe("durable isolated Git receiver", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cc-git-receive-"));
    await mkdir(join(directory, "receive.git"));
    await writeFile(join(directory, "prepared.json"), JSON.stringify({ sourceRevision: grant.sourceRevision }));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const successful = () => vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === "rev-parse") return Buffer.from(oid);
    return Buffer.from("accepted");
  });
  it("caches an exact successful replay without invoking Git twice", async () => {
    const command = successful(), receiver = new CloudGitReceiver(command);
    await expect(receiver.receive(directory, grant, body)).resolves.toEqual(Buffer.from("accepted"));
    expect(command).toHaveBeenCalledTimes(3);
    await expect(receiver.receive(directory, grant, body)).resolves.toEqual(Buffer.from("accepted"));
    expect(command).toHaveBeenCalledTimes(3);
    await expect(receiver.receive(directory, grant, Buffer.concat([body, Buffer.from("changed")]))).rejects.toThrow("conflict");
  });
  it("does not repeat a failed or ambiguous receive", async () => {
    const command = vi.fn(async () => { throw new Error("interrupted"); });
    const receiver = new CloudGitReceiver(command);
    await expect(receiver.receive(directory, grant, body)).rejects.toThrow("interrupted");
    await expect(receiver.receive(directory, grant, body)).rejects.toThrow("unknown");
    expect(command).toHaveBeenCalledTimes(1);
    await expect(receiver.result(directory)).resolves.toBeNull();
  });
  it("allows only one concurrent writer", async () => {
    let entered!: () => void;
    let release!: () => void;
    const receiving = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const command = successful();
    command.mockImplementationOnce(async () => {
      entered();
      await finish;
      return Buffer.from("accepted");
    });
    const receiver = new CloudGitReceiver(command);
    const first = receiver.receive(directory, grant, body);
    // Wait for the durable intent and hold Git open: scheduler speed must not
    // turn the competing request into a valid replay of a completed receive.
    try {
      await Promise.race([receiving, first]);
      await expect(new CloudGitReceiver(command).receive(directory, grant, body)).rejects.toThrow("cloud_git_receive_unknown");
      expect(command).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
    await expect(receiver.receive(directory, grant, body)).resolves.toEqual(Buffer.from("accepted"));
    expect(command).toHaveBeenCalledTimes(3);
  });
  it("does not mark ancestry failure as received", async () => {
    const command = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "merge-base") throw new Error("unrelated");
      return Buffer.from(args[0] === "rev-parse" ? oid : "accepted");
    });
    const receiver = new CloudGitReceiver(command);
    await expect(receiver.receive(directory, grant, body)).rejects.toThrow("unrelated");
    await expect(receiver.result(directory)).resolves.toBeNull();
  });
  it("rejects oversized input before launching Git", async () => {
    const command = successful();
    await expect(new CloudGitReceiver(command).receive(directory, { ...grant, maxPackBytes: 1 }, body)).rejects.toThrow("too_large");
    expect(command).not.toHaveBeenCalled();
  });
});
