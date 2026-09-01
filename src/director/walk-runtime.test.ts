import { describe, expect, it, vi } from "vitest";
import { startCuriosityWalk, type CuriosityWalkDeps } from "./walk-runtime.js";
import type { WalkMaterial } from "./walk-materials.js";

function makeDeps(patch: Partial<CuriosityWalkDeps> = {}) {
  const invoke = vi.fn(async (_input: Parameters<CuriosityWalkDeps["delegationService"]["invoke"]>[0]) => ({
    ok: true as const,
    run: { id: "run-1", status: "spawned" },
  }));
  const insert = vi.fn(() => ({
    id: "walk-1",
    team_id: "team-1",
    subsidiary_id: "sub-1",
    repo_a: "Alpha",
    repo_b: "Beta",
    material_a: "Alpha spec",
    material_b: "Beta spec",
    combo_key: "alpha|beta",
    run_id: null,
    created_at: 1,
  }));
  const setRunId = vi.fn();
  const timers: Array<() => void> = [];
  const deps: CuriosityWalkDeps = {
    teams: {
      listActive: () => [{ id: "team-1", name: "Team One", slug: "team-one", subsidiary_id: "sub-1" }],
      repos: () => ["Alpha"],
    },
    walks: { insert, setRunId, recentComboKeys: () => new Set() },
    materials: async () => [
      { repo: "Alpha", kind: "spec", label: "Alpha spec", detail: "C:/work/Alpha/spec/a.md" },
      { repo: "Beta", kind: "spec", label: "Beta spec", detail: "C:/work/Beta/spec/b.md" },
    ],
    delegationService: { invoke },
    cwd: "C:/work",
    rand: () => 0,
    setTimer: (fn) => {
      timers.push(fn);
      return { clear: vi.fn() };
    },
    ...patch,
  };
  const handle = startCuriosityWalk(deps);
  return { handle, invoke, insert, setRunId, timers };
}

describe("curiosity walk runtime", () => {
  it("launches from an explicit cwd and keeps subsidiary teams on the head-office route", async () => {
    const h = makeDeps();
    await h.handle.runOnce();

    expect(h.invoke).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "C:/work",
      options: { goal_and_go: false },
    }));
    const invocation = h.invoke.mock.calls[0]![0];
    expect(invocation).not.toHaveProperty("subsidiary_id");
    expect(invocation.options).not.toHaveProperty("team");
    expect(h.setRunId).toHaveBeenCalledWith("walk-1", "run-1");
  });

  it("does not record a spawn_failed run as a launched walk", async () => {
    const h = makeDeps({
      delegationService: {
        invoke: vi.fn(async () => ({ ok: true as const, run: { id: "run-failed", status: "spawn_failed" } })),
      },
    });
    await h.handle.runOnce();
    expect(h.setRunId).not.toHaveBeenCalled();
  });

  it("does not launch after the workflow is stopped during material collection", async () => {
    let resolveMaterials!: (value: WalkMaterial[]) => void;
    const materials = new Promise<WalkMaterial[]>((resolve) => {
      resolveMaterials = resolve;
    });
    const h = makeDeps({ materials: () => materials });

    const run = h.handle.runOnce();
    h.handle.stop();
    resolveMaterials([
      { repo: "Alpha", kind: "spec", label: "Alpha spec", detail: "a" },
      { repo: "Beta", kind: "spec", label: "Beta spec", detail: "b" },
    ]);
    await run;

    expect(h.insert).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
