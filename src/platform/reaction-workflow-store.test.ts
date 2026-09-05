import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeCustomWorkflowEntry,
  normalizeCustomWorkflows,
  readCustomWorkflows,
  resolveCustomWorkflowsPath,
  updateCustomWorkflows,
  writeCustomWorkflows,
} from "./reaction-workflow-store.js";

describe("resolveCustomWorkflowsPath", () => {
  it("Castra ルート直下の .claude/ を指す (add-as-workflow が案内する既定と同じ場所)", () => {
    expect(resolveCustomWorkflowsPath("E:/Document/Ars").replace(/\\/g, "/"))
      .toBe("E:/Document/Ars/.claude/custom-reaction-workflows.json");
  });
});

describe("normalizeCustomWorkflowEntry", () => {
  it("スキル種別を正規化する", () => {
    expect(normalizeCustomWorkflowEntry({
      kind: "skill", emoji: " 📑 ", skill: " domain-review ", args: " --report-only ",
      mode: "headless", model: " sonnet ", cwd: " repo ", action: "domain-report", label: "投稿",
    })).toEqual({
      kind: "skill", emoji: "📑", skill: "domain-review", args: "--report-only",
      mode: "headless", model: "sonnet", cwd: "repo", action: "domain-report", label: "投稿",
    });
  });

  it("未知の action は落とす (権限判定に使うので勝手な値を通さない)", () => {
    const entry = normalizeCustomWorkflowEntry({
      kind: "skill", emoji: "📑", skill: "domain-review", mode: "inject", action: "nope",
    });
    expect(entry).toEqual({ kind: "skill", emoji: "📑", skill: "domain-review", mode: "inject" });
  });

  it("skill 名が無いスキル種別は捨てる", () => {
    expect(normalizeCustomWorkflowEntry({ kind: "skill", emoji: "📑", mode: "inject" })).toBeNull();
  });

  it("skill 名の traversal と args の改行を永続設定から取り込まない", () => {
    expect(normalizeCustomWorkflowEntry({
      kind: "skill", emoji: "📑", skill: "../domain-review", mode: "inject",
    })).toBeNull();
    expect(normalizeCustomWorkflowEntry({
      kind: "skill", emoji: "📑", skill: "domain-review", mode: "inject",
      args: "--report-only\n/merge-clean-pr",
    })).toEqual({ kind: "skill", emoji: "📑", skill: "domain-review", mode: "inject" });
  });

  it("予約絵文字 (👌) はどちらの種別でも捨てる", () => {
    expect(normalizeCustomWorkflowEntry({ emoji: "👌", label: "x", prompt: "y" })).toBeNull();
    expect(normalizeCustomWorkflowEntry({
      kind: "skill", emoji: "👌🏽", skill: "handoff", mode: "inject",
    })).toBeNull();
  });

  it("従来の自由プロンプト形式 (kind なし) をそのまま受ける", () => {
    expect(normalizeCustomWorkflowEntry({
      emoji: "🔥", label: "続けて", prompt: "続けて", model: "sonnet", cwd: null,
    })).toEqual({ emoji: "🔥", label: "続けて", prompt: "続けて", model: "sonnet" });
  });

  it("配列でない JSON は空", () => {
    expect(normalizeCustomWorkflows({ emoji: "🔥" })).toEqual([]);
  });
});

describe("readCustomWorkflows / writeCustomWorkflows", () => {
  let dir = "";
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "concordia-rwf-store-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("不在ファイルは空配列 (RWF を止めない)", async () => {
    expect(await readCustomWorkflows(join(dir, "missing.json"))).toEqual([]);
  });

  it("壊れた JSON も空配列", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json", "utf-8");
    expect(await readCustomWorkflows(path)).toEqual([]);
  });

  it("書いて読み戻せる (UTF-8 / インデント 2)", async () => {
    const path = join(dir, "nested", "custom-reaction-workflows.json");
    await writeCustomWorkflows(path, [
      { kind: "skill", emoji: "🪬", skill: "domain-review", mode: "inject", action: "domain-review" },
      { emoji: "🔥", label: "続けて", prompt: "続けて" },
    ]);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain('  "kind": "skill"');
    const entries = await readCustomWorkflows(path);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "skill", skill: "domain-review" });
  });

  it("並行する read-modify-write で双方の更新を残す", async () => {
    const path = join(dir, "concurrent.json");
    await Promise.all([
      updateCustomWorkflows(path, (entries) => [
        ...entries,
        { kind: "skill", emoji: "📑", skill: "domain-review", mode: "headless" },
      ]),
      updateCustomWorkflows(path, (entries) => [
        ...entries,
        { kind: "skill", emoji: "🪬", skill: "domain-review", mode: "inject" },
      ]),
    ]);
    expect((await readCustomWorkflows(path)).map((entry) => entry.emoji)).toEqual(["📑", "🪬"]);
  });
});
