import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Exercise orchestration with inert provider responses: no agent, network, or child process starts.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function run(script, args, response = {}) {
  const source = readFileSync(new URL(`../spec/plan/2026-10-16-ludiars-design-review-handoff/${script}`, import.meta.url), "utf8")
    .replace("export const meta", "const meta");
  const calls = [];
  const task = new AsyncFunction("args", "phase", "parallel", "agent", "log", source);
  return { calls, result: task(args, () => {}, (jobs) => Promise.all(jobs.map((job) => job())),
    async (prompt, options) => { calls.push({ prompt, options }); return response; }, () => {}) };
}
const paths = { root: "E:\\Document\\Ars", wf: "E:\\Review Evidence" };

describe("portable review workflows", () => {
  it.each(["analyze.js", "verify.js", "ludiars-understand-split.js"])("requires root before work: %s", async (script) => {
    const execution = run(script, {});
    await expect(execution.result).rejects.toThrow(/args\.(root|wf)/);
    expect(execution.calls).toEqual([]);
  });
  it.each(["analyze.js", "verify.js"])("requires an evidence directory: %s", async (script) => {
    const execution = run(script, { root: paths.root });
    await expect(execution.result).rejects.toThrow(/args.wf/);
    expect(execution.calls).toEqual([]);
  });
  it.each([[], ["d7"], ["d1", "d1"], "d1"].map((value) => [value]))("rejects invalid dimensions: %j", async (dimensions) => {
    const execution = run("analyze.js", { ...paths, dimensions });
    await expect(execution.result).rejects.toThrow(/dimensions/);
    expect(execution.calls).toEqual([]);
  });
  it("passes portable paths and preserves successful analyst output", async () => {
    const execution = run("analyze.js", { ...paths, dimensions: ["d1"] }, { findings: [] });
    expect(await execution.result).toEqual({ dimensions: ["d1"], results: [{ findings: [] }] });
    expect(execution.calls[0].prompt).toContain("E:/Review Evidence/digest-d1-domain-overlap.md");
    expect(execution.calls[0].prompt).toContain("E:/Document/Ars/");
  });
  it("fails when an analyst does not return evidence", async () => {
    await expect(run("analyze.js", { ...paths, dimensions: ["d1"] }, null).result).rejects.toThrow(/Missing analyst/);
  });
  it.each([[], [{ name: "empty", findings: [] }], [{ findings: [{}] }]].map((value) => [value]))("refuses empty or malformed verification batches: %j", async (batches) => {
    const execution = run("verify.js", { ...paths, batches });
    await expect(execution.result).rejects.toThrow(/batches/);
    expect(execution.calls).toEqual([]);
  });
  it("fails if either verification lens has no result", async () => {
    await expect(run("verify.js", { ...paths, batches: [{ name: "Cc", findings: [{ id: "D1-01" }] }] }, null).result).rejects.toThrow(/Missing verification lens/);
  });
  it("returns both lenses", async () => {
    const execution = run("verify.js", { ...paths, batches: [{ name: "Cc", findings: [{ id: "D1-01" }] }] }, { verdicts: [] });
    expect(await execution.result).toEqual([{ batch: "Cc", evidence: { verdicts: [] }, counter: { verdicts: [] } }]);
    expect(execution.calls).toHaveLength(2);
  });
  it("rejects unknown readers before starting an agent", async () => {
    const execution = run("ludiars-understand-split.js", { ...paths, readers: ["read:typo"], scouts: false });
    await expect(execution.result).rejects.toThrow(/readers/);
    expect(execution.calls).toEqual([]);
  });
  it("allows explicit scouts-only work and records selected reader labels", async () => {
    const execution = run("ludiars-understand-split.js", { ...paths, readers: [], scouts: true });
    expect((await execution.result).readerLabels).toEqual([]);
    expect(execution.calls).toHaveLength(2);
  });
  it("rejects a selection that does no work", async () => {
    const execution = run("ludiars-understand-split.js", { ...paths, readers: [], scouts: false });
    await expect(execution.result).rejects.toThrow(/at least one/);
    expect(execution.calls).toEqual([]);
  });
  it("does not hide failed readers or scouts", async () => {
    await expect(run("ludiars-understand-split.js", { ...paths, readers: ["read:Augur"], scouts: false }, null).result).rejects.toThrow(/Missing reader/);
    await expect(run("ludiars-understand-split.js", { ...paths, readers: [], scouts: true }, null).result).rejects.toThrow(/Missing scout/);
  });
});
