import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactReceiver } from "./artifact-receiver.js";

describe("durable artifact reception", () => {
  let root: string, now: number, receiver: ArtifactReceiver;
  const input = { target: "Tokyo2070", attempt: "trial", name: "model.blend", maxBytes: 100, issuedAt: 1000, expiresAt: 2000 };
  const bytes = new Uint8Array([0, 255, 10, 13, 128]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const body = (): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cc-artifact-")); now = 1000; receiver = new ArtifactReceiver(root, () => now); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("preserves binary bytes across restart and replays only an identical receipt", async () => {
    const { token, grant } = await receiver.issue(input);
    expect(await readFile(join(root, input.target, input.attempt, "grant.json"), "utf8")).not.toContain(token);
    expect(await receiver.receive(grant, token, bytes.length, digest, body())).toEqual({ name: input.name, bytes: bytes.length, sha256: digest });
    receiver = new ArtifactReceiver(root, () => now);
    expect(await receiver.status(grant)).toMatchObject({ state: "received" });
    expect(await readFile(join(root, input.target, input.attempt, "payload"))).toEqual(Buffer.from(bytes));
    await expect(receiver.receive(grant, token, bytes.length, digest, body())).resolves.toMatchObject({ sha256: digest });
    await expect(receiver.receive(grant, token, bytes.length, "a".repeat(64), body())).rejects.toThrow();
  });
  it("rejects wrong token, cross-run capability, expiry and grant replacement", async () => {
    const { token } = await receiver.issue(input);
    await expect(receiver.authorize(input.target, input.attempt, "x".repeat(43))).rejects.toThrow();
    await expect(receiver.authorize(input.target, "other", token)).rejects.toThrow();
    await expect(receiver.issue(input)).rejects.toThrow();
    now = 2000;
    await expect(receiver.authorize(input.target, input.attempt, token)).rejects.toThrow();
  });
  it.each(["../escape", "C:\\escape", "a/b"])("rejects path %s", async target => {
    await expect(receiver.issue({ ...input, target })).rejects.toThrow();
  });
  it("does not complete a corrupted or interrupted transfer or retry unknown writes", async () => {
    const { token, grant } = await receiver.issue(input);
    await expect(receiver.receive(grant, token, bytes.length, "a".repeat(64), body())).rejects.toThrow();
    expect(await receiver.status(grant)).toEqual({ state: "unknown" });
    await expect(receiver.receive(grant, token, bytes.length, digest, body())).rejects.toThrow();
  });
  it("rejects over-budget content without starting an intent", async () => {
    const { token, grant } = await receiver.issue(input);
    await expect(receiver.receive(grant, token, 101, digest, body())).rejects.toThrow();
    expect(await receiver.status(grant)).toEqual({ state: "pending" });
  });
  it("checks expiry again at completion", async () => {
    const { token, grant } = await receiver.issue(input);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); now = 2000; c.close(); } });
    await expect(receiver.receive(grant, token, bytes.length, digest, stream)).rejects.toThrow();
    expect(await receiver.status(grant)).toEqual({ state: "unknown" });
  });
  it("accepts only one concurrent write", async () => {
    const { token, grant } = await receiver.issue(input);
    const results = await Promise.allSettled([receiver.receive(grant, token, bytes.length, digest, body()), receiver.receive(grant, token, bytes.length, digest, body())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
});
