import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { reactionSkillWorkflowRouter } from "./reaction-skill-workflows.js";
import type { SkillCatalogStore } from "../skills/catalog-store.js";
import { readCustomWorkflows, resolveCustomWorkflowsPath, writeCustomWorkflows } from "../platform/reaction-workflow-store.js";
it("offers presets and adds only installed skills without changing an existing custom prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-rwf-presets-"));
  try {
    const path = resolveCustomWorkflowsPath(root);
    const existing = { emoji: "🧠️", label: "my action", prompt: "keep" };
    await writeCustomWorkflows(path, [existing]);
    const skills = [{ name: "context-report", rwf: [] }, { name: "handoff", rwf: [] }];
    const catalog = { current: () => ({ entries: skills, scannedAt: 1, notes: [] }),
      find: vi.fn((name: string) => skills.find(skill => skill.name === name)) } as unknown as SkillCatalogStore;
    const app = reactionSkillWorkflowRouter({ resolveWorkspaceRoot: () => root, catalog });
    const list = await (await app.request("/")).json();
    expect(list.presets.find((p: { skill: string }) => p.skill === "remaining-enumerate").available).toBe(false);
    expect(await readCustomWorkflows(path)).toEqual([existing]);
    const added = await app.request("/presets", { method: "POST" });
    expect(added.status).toBe(200);
    expect((await added.json()).missing_skills).toEqual(["remaining-enumerate"]);
    const saved = await readCustomWorkflows(path);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(existing);
    await app.request("/presets", { method: "POST" });
    expect(await readCustomWorkflows(path)).toEqual(saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});
