import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectWalkMaterials, sampleWalkPair, type WalkMaterial } from "./walk-materials.js";

function material(repo: string, label: string): WalkMaterial {
  return { repo, kind: "spec", label, detail: `${repo}/${label}` };
}

describe("sampleWalkPair", () => {
  const materials = [
    material("Pictor", "a.md"),
    material("Pictor", "b.md"),
    material("Ergo", "c.md"),
    material("Memoria", "d.md"),
  ];

  it("returns two materials from different repos", () => {
    const pair = sampleWalkPair(materials, { rand: () => 0.1 });
    expect(pair).not.toBeNull();
    expect(pair!.a.repo.toLowerCase()).not.toBe(pair!.b.repo.toLowerCase());
  });

  it("biases material A toward the team's repos", () => {
    const pair = sampleWalkPair(materials, { biasRepos: ["LUDIARS/Memoria"], rand: () => 0.1 });
    expect(pair!.a.repo).toBe("Memoria");
    expect(pair!.b.repo).not.toBe("Memoria");
  });

  it("normalizes URL, SSH, and .git team repo origins for biasing", () => {
    for (const origin of [
      "https://github.com/LUDIARS/Memoria.git",
      "git@github.com:LUDIARS/Memoria.git",
      "LUDIARS\\Memoria.git",
    ]) {
      const pair = sampleWalkPair(materials, { biasRepos: [origin], rand: () => 0.1 });
      expect(pair!.a.repo).toBe("Memoria");
    }
  });

  it("avoids recently used combos when alternatives exist", () => {
    let calls = 0;
    // 順番に別の組み合わせが出るよう乱数を回す。
    const rand = () => {
      calls += 1;
      return (calls * 0.37) % 1;
    };
    const recent = new Set(["ergo|pictor"]);
    for (let i = 0; i < 5; i += 1) {
      const pair = sampleWalkPair(materials, { recentCombos: recent, rand });
      expect(pair).not.toBeNull();
      expect(recent.has(pair!.comboKey)).toBe(false);
    }
  });

  it("does not reuse a recent combo even when randomness repeatedly selects its position", () => {
    const pair = sampleWalkPair(materials, {
      recentCombos: new Set(["ergo|pictor"]),
      rand: () => 0,
    });
    expect(pair).not.toBeNull();
    expect(pair!.comboKey).not.toBe("ergo|pictor");
  });

  it("returns null when only one repo has materials", () => {
    expect(sampleWalkPair([material("Pictor", "a.md"), material("Pictor", "b.md")])).toBeNull();
  });
});

describe("collectWalkMaterials", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "walk-materials-"));
    await mkdir(join(root, "Alpha", "spec", "feature"), { recursive: true });
    await mkdir(join(root, "Beta", "spec", "tasks"), { recursive: true });
    await mkdir(join(root, "node_modules", "junk"), { recursive: true });
    await writeFile(join(root, "Alpha", "spec", "feature", "one.md"), "# one");
    await writeFile(join(root, "Beta", "spec", "tasks", "two.md"), "# two");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("collects specs/tasks per repo and merges PR/case sources", async () => {
    const materials = await collectWalkMaterials({
      workspaceRoots: [root],
      recentlyMergedPrs: () => [{ repo_origin: "LUDIARS/Gamma", number: 12, title: "fix" }],
      directorCases: () => [{ project: "Delta", title: "目標", goal: "遊びを増やす" }],
    });
    const repos = new Set(materials.map((m) => m.repo));
    expect(repos).toContain("Alpha");
    expect(repos).toContain("Beta");
    expect(repos).toContain("Gamma");
    expect(repos).toContain("Delta");
    expect(repos.has("node_modules")).toBe(false);
  });
});
