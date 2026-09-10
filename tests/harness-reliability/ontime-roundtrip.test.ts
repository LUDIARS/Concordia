import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const capture = vi.hoisted(() => {
  // The registered suite shares its module cache (isolate: false). Reload the
  // installed wrappers so they bind to this file's logging mock as well.
  vi.resetModules();
  return { lines: [] as string[] };
});
vi.mock("../../src/shared/vestigium.js", () => ({ vgWrite: (_level: string, msg: string, ctx: unknown) => capture.lines.push(JSON.stringify({ msg, ctx })) }));
import { sampleDecision } from "../../src/harness/reliability/guidance.js";
import { workflowGuidance } from "../../src/harness/reliability/workflow-guidance.js";

const augur = resolve(process.cwd(), "../Augur/bin/augur.mjs");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.skipIf(!existsSync(augur))("aggregates actual installed markers using the Augur CLI without an LLM or server", () => {
  const logs = mkdtempSync(join(tmpdir(), "cc-ontime-")); roots.push(logs);
  capture.lines.length = 0;
  const since = new Date(Date.now() - 1000).toISOString();
  sampleDecision({ count: 1, samples: 0, slot: 1, lastSlot: 0, random: 0.9 });
  sampleDecision({ count: 20, samples: 12, slot: 2, lastSlot: 0, random: 0 });
  workflowGuidance("[自動確認] 実装を調査");
  expect(capture.lines).toHaveLength(3);
  writeFileSync(join(logs, "fixture.jsonl"), capture.lines.join("\n") + "\n");
  const result = spawnSync(process.execPath, ["tools/concordia-ontime.mjs", "report", "--augur", augur,
    "--logs-dir", logs, "--since", since], { cwd: process.cwd(), encoding: "utf8", timeout: 15000, windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(Array.isArray(report)).toBe(true);
  expect(report).toHaveLength(2);
  expect(report.every((item: { met: boolean }) => item.met)).toBe(true);
}, 20000);
