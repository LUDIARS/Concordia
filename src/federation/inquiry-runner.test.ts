import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INQUIRY_QUEUE_LIMIT, createInquiryRunner, inquiryEnvironment, resolveInquiryCwd } from "./inquiry-runner.js";

describe("resolveInquiryCwd", () => {
  it("rejects traversal, absolute paths and projects linked outside the root", async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), "cc-inquiry-scope-")));
    try {
      const root = join(temp, "root"); const outside = join(temp, "outside");
      await mkdir(root); await mkdir(outside);
      await symlink(outside, join(root, "escape"), "junction");
      for (const project of ["../outside", outside, "escape", ".", ""]) {
        expect(await resolveInquiryCwd([root], project)).toBeNull();
      }
      expect(await resolveInquiryCwd([join(temp, "missing")], undefined)).toBeNull();
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
  it("finds a project under the workspace roots and falls back to the first root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-inquiry-"));
    await mkdir(join(root, "Concordia"));
    expect(await resolveInquiryCwd([root], "Concordia")).toBe(join(root, "Concordia"));
    expect(await resolveInquiryCwd([root], "Missing")).toBeNull();
    expect(await resolveInquiryCwd([root], undefined)).toBe(root);
    expect(await resolveInquiryCwd([], undefined)).toBeNull();
  });
});

describe("inquiryEnvironment", () => {
  it("drops session and coordinator identity", () => {
    const env = inquiryEnvironment({ PATH: "p", CONCORDIA_SESSION_ID: "s", LICTOR_SESSION: "l", CLAUDECODE: "1" });
    expect(env).toEqual({ PATH: "p" });
  });
});

describe("createInquiryRunner", () => {
  it("runs once in the project directory with the read-only preface and records cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-inquiry-"));
    const seen: Array<{ cwd: string; prompt: string; timeoutMs: number }> = [];
    const recorded: unknown[] = [];
    const run = createInquiryRunner({
      workspaceRoots: () => [root],
      execute: async (input) => { seen.push(input); return { ok: true, output: "answer", error: null }; },
      record: (input) => { recorded.push(input); },
    });
    const result = await run({ origin: "hq", prompt: "見て", timeoutSec: 60 });
    expect(result).toMatchObject({ ok: true, output: "answer", error: null });
    expect(seen[0]).toMatchObject({ cwd: root, timeoutMs: 60_000 });
    expect(seen[0]!.prompt).toContain("変更しないでください");
    expect(recorded).toHaveLength(1);
  });

  it("reports a missing project without running", async () => {
    const run = createInquiryRunner({ workspaceRoots: () => [tmpdir()], execute: async () => { throw new Error("must not run"); }, record: () => {} });
    const result = await run({ origin: "hq", prompt: "x", project: "NoSuchProject123", timeoutSec: 60 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("project not found");
  });

  it("runs one at a time and rejects beyond the queue limit", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run = createInquiryRunner({
      workspaceRoots: () => [tmpdir()],
      record: () => {},
      execute: () => new Promise((done) => {
        active += 1;
        peak = Math.max(peak, active);
        releases.push(() => { active -= 1; done({ ok: true, output: "", error: null }); });
      }),
    });
    const running = Array.from({ length: INQUIRY_QUEUE_LIMIT + 1 }, () => run({ origin: "hq", prompt: "x", timeoutSec: 60 }));
    const rejected = await run({ origin: "hq", prompt: "x", timeoutSec: 60 });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("busy");
    let settled = 0;
    const all = Promise.all(running.map((pending) => pending.finally(() => { settled += 1; })));
    while (settled < running.length) {
      await new Promise((tick) => setTimeout(tick, 0));
      releases.shift()?.();
    }
    expect((await all).every((result) => result.ok)).toBe(true);
    expect(peak).toBe(1);
  });
});
