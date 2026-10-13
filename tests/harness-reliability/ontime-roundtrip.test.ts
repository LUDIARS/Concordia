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
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sampleDecision } from "../../src/harness/reliability/guidance.js";
import { workflowGuidance } from "../../src/harness/reliability/workflow-guidance.js";

// Augur は Concordia 本体の隣にある。linked worktree (審査・作業用) から走らせても見つかるよう、
// cwd の隣に無ければ本体 checkout の隣を見る。
const augur = [process.cwd(), mainCheckoutPath(process.cwd())]
  .map((root) => resolve(root, "../Augur/bin/augur.mjs"))
  .find((candidate) => existsSync(candidate)) ?? resolve(process.cwd(), "../Augur/bin/augur.mjs");
function mainCheckoutPath(repoPath: string): string {
  try {
    const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(join(repoPath, ".git"), "utf8"))?.[1]?.trim();
    if (!gitdir) return repoPath;
    const metadata = resolve(repoPath, gitdir);
    return dirname(resolve(metadata, readFileSync(join(metadata, "commondir"), "utf8").trim()));
  } catch { return repoPath; }
}
const ROUNDTRIP_CONTRACTS =new Set(["HR-sampling-budget", "HR-workflow-source"]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.skipIf(!existsSync(augur))("aggregates actual installed markers using the Augur CLI without an LLM or server", () => {
  const logs = mkdtempSync(join(tmpdir(), "cc-ontime-")); roots.push(logs);
  capture.lines.length = 0;
  const since = new Date(Date.now() - 1000).toISOString();
  sampleDecision({ count: 1, samples: 0, slot: 1, lastSlot: 0, random: 0.9 });
  sampleDecision({ count: 20, samples: 12, slot: 2, lastSlot: 0, random: 0 });
  workflowGuidance("[自動確認] 実装を調査");
  // 同じ関数に後から別の契約 (例: bounty-intake-C-8) が重ねられても、この往復の対象だけを見る。
  const lines = capture.lines.filter((line) => ROUNDTRIP_CONTRACTS.has(JSON.parse(line).ctx?.contract));
  expect(lines).toHaveLength(3);
  writeFileSync(join(logs, "fixture.jsonl"), lines.join("\n") + "\n");
  const result = spawnSync(process.execPath, ["tools/concordia-ontime.mjs", "report", "--augur", augur,
    "--logs-dir", logs, "--since", since], { cwd: process.cwd(), encoding: "utf8", timeout: 15000, windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(Array.isArray(report)).toBe(true);
  // report は manifest の全契約を返す (未観測は met:false)。往復した 2 契約だけを判定する。
  const roundtrip = report.filter((item: { criterion: string }) =>
    ROUNDTRIP_CONTRACTS.has(item.criterion.split(":", 1)[0]));
  expect(roundtrip).toHaveLength(2);
  expect(roundtrip.every((item: { met: boolean }) => item.met)).toBe(true);
}, 20000);
