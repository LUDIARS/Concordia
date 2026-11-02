import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Hono } from "hono";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import { branchCommandWords, requiresTaskBranchCheck } from "../../src/harness/reliability/task-branch-policy.js";
import { MAX_WORKING_TARGETS, readWorkingTargets, upsertWorkingTarget } from "../../src/harness/reliability/working-targets.js";
import { registerWorkingTargetsRoutes } from "../../src/api/sessions/working-targets.js";
import { makeTestDb } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import type { BranchSnapshot } from "../../src/harness/reliability/task-branch-git.js";

/**
 * TB-MULTI: the 2026-11 loop. A Castra-rooted session whose inferred target moved to another repository
 * could not edit a third repository: the denial told it to run `task set --branch`, which cannot name a
 * repository, so every re-registration was denied again.
 */
describe("a session can hold several checkout registrations (TB-MULTI)", () => {
  const root = resolve("fixture/castra"), engine = resolve("fixture/castra/engine"), game = resolve("fixture/game");
  const gameWt = resolve("fixture/game-wt"), other = resolve("fixture/other");
  const snapshots: Record<string, BranchSnapshot> = {
    [root]: { repo: root, branch: "main", mainExists: true, commonDir: resolve("fixture/castra/.git"), checkouts: [{ repo: root, branch: "main" }] },
    [engine]: { repo: engine, branch: "main", mainExists: true, commonDir: resolve("fixture/castra/engine/.git"), checkouts: [{ repo: engine, branch: "main" }] },
    [game]: { repo: game, branch: "dev", mainExists: true, commonDir: resolve("fixture/game/.git"),
      checkouts: [{ repo: game, branch: "dev" }, { repo: gameWt, branch: "fix/crash" }] },
    [gameWt]: { repo: gameWt, branch: "fix/crash", mainExists: true, commonDir: resolve("fixture/game/.git") },
    [other]: { repo: other, branch: "main", mainExists: true, commonDir: resolve("fixture/other/.git"), checkouts: [{ repo: other, branch: "main" }] },
  };

  function setup(input: { repo_path?: string; branch?: string; target_project?: string | null } = {}) {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    sessions.insertSession({ id: "multi", provider: "claude-code", repo_path: input.repo_path ?? root, repo_origin: null,
      branch: input.branch ?? "main", host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
      target_project: input.target_project === undefined ? engine : input.target_project });
    const service = new TaskBranchService(sessions, async (cwd) => {
      const snapshot = snapshots[resolve(cwd)];
      if (!snapshot) throw new Error(`not a fixture checkout: ${cwd}`);
      return snapshot;
    }, undefined, undefined, () => [root]);
    const app = new Hono();
    registerWorkingTargetsRoutes(app, { repo: sessions });
    const gate = (action: { tool: string; command?: string; cwd: string }) => service.gate("multi", action);
    /** Runs the registration a denial suggested, the way Lictor sends it to Cc. */
    const runSuggested = async (suggestion: string | undefined) => {
      const command = /`(lictor cli task set [^`]+)`/.exec(suggestion ?? "")?.[1];
      expect(command, "the denial names a registration command").toBeTruthy();
      const words = branchCommandWords(command);
      // The command itself passes the gate, otherwise the session could not run it.
      expect(requiresTaskBranchCheck({ tool: "Bash", command, cwd: root })).toBe(false);
      const value = (flag: string) => words[words.indexOf(flag) + 1];
      const response = await app.request("/multi/working-targets", { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ add: { repo: value("--repo"), branch: value("--branch") } }) });
      expect(response.status).toBe(200);
      return (await response.json()) as { registration: { working_targets: Array<{ repo: string; branch: string }> } };
    };
    return { sessions, gate, app, runSuggested, close: () => db.close() };
  }

  it("lets the suggested command make the same edit pass, and keeps the other registrations working", async () => {
    const { gate, runSuggested, close } = setup();
    try {
      const denied = await gate({ tool: "Edit", cwd: game });
      expect(denied?.rule).toBe("task-branch");
      expect(denied?.reason).toContain(`実際: ${game}@dev`);
      expect(denied?.reason).toContain(`推定対象: ${engine}`);
      const result = await runSuggested(denied?.suggestion);
      expect(result.registration.working_targets).toEqual([expect.objectContaining({ repo: game, branch: "dev", source: "explicit" })]);
      expect(await gate({ tool: "Edit", cwd: game })).toBeNull();
      // The root registration still decides commands from the root.
      expect(await gate({ tool: "Bash", command: "node build.mjs", cwd: root })).toBeNull();
      // A checkout nobody registered stays denied.
      expect((await gate({ tool: "Edit", cwd: other }))?.rule).toBe("task-branch");
      // The registered repository on another branch stays denied too.
      expect((await gate({ tool: "Edit", cwd: gameWt }))?.rule).toBe("task-branch");
    } finally { close(); }
  });

  it("makes every checkout-mismatch denial recoverable by its own suggestion", async () => {
    const cases: Array<{ session: Parameters<typeof setup>[0]; action: { tool: string; command?: string; cwd: string } }> = [
      { session: {}, action: { tool: "Edit", cwd: game } },
      { session: {}, action: { tool: "Write", cwd: gameWt } },
      { session: { repo_path: engine, branch: "fix/gone", target_project: root }, action: { tool: "Bash", command: "node build.mjs", cwd: other } },
      { session: { repo_path: game, branch: "dev", target_project: null }, action: { tool: "Edit", cwd: gameWt } },
    ];
    for (const { session, action } of cases) {
      const { gate, runSuggested, close } = setup(session);
      try {
        const denied = await gate(action);
        expect(denied?.rule, JSON.stringify(action)).toBe("task-branch");
        await runSuggested(denied?.suggestion);
        expect(await gate(action), JSON.stringify(action)).toBeNull();
      } finally { close(); }
    }
  });

  it("keeps explicit registrations when the inferred target moves", async () => {
    const { sessions, gate, runSuggested, close } = setup();
    try {
      await runSuggested((await gate({ tool: "Edit", cwd: game }))?.suggestion);
      sessions.patchSession("multi", { target_project: other });
      expect(await gate({ tool: "Edit", cwd: game })).toBeNull();
      expect(readWorkingTargets(sessions.findSession("multi")!.metadata)).toHaveLength(1);
    } finally { close(); }
  });

  it("removes a registration on request", async () => {
    const { gate, app, runSuggested, close } = setup();
    try {
      await runSuggested((await gate({ tool: "Edit", cwd: game }))?.suggestion);
      const response = await app.request("/multi/working-targets", { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ remove: { repo: game } }) });
      expect(((await response.json()) as { registration: { working_targets: unknown[] } }).registration.working_targets).toEqual([]);
      expect((await gate({ tool: "Edit", cwd: game }))?.rule).toBe("task-branch");
    } finally { close(); }
  });

  it("rejects a relative repository path", async () => {
    const { app, close } = setup();
    try {
      const response = await app.request("/multi/working-targets", { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ add: { repo: "game", branch: "dev" } }) });
      expect(response.status).toBe(400);
    } finally { close(); }
  });

  it("reports the decision values once the same denial repeats, and forgets it after a pass", async () => {
    const { sessions, gate, runSuggested, close } = setup();
    try {
      const first = await gate({ tool: "Edit", cwd: game });
      expect(first?.reason).not.toContain("同じ拒否");
      const second = await gate({ tool: "Edit", cwd: game });
      expect(second?.reason).toContain("同じ拒否が 2 回");
      expect(second?.reason).toContain("castra_registration");
      await gate({ tool: "Edit", cwd: game });
      expect(sessions.eventsByKind("multi", "harness.task_branch.repeated_denial")).toHaveLength(1);
      await runSuggested(second?.suggestion);
      expect(await gate({ tool: "Edit", cwd: game })).toBeNull();
      expect((await gate({ tool: "Edit", cwd: other }))?.reason).not.toContain("同じ拒否");
    } finally { close(); }
  });
});

describe("working target list", () => {
  it("does not let an inferred target replace an explicit one", () => {
    const explicit = { repo: resolve("fixture/game"), branch: "dev", source: "explicit" as const, registered_at: 1 };
    const list = upsertWorkingTarget([explicit], { ...explicit, branch: "main", source: "inferred", registered_at: 2 });
    expect(list).toEqual([explicit]);
    expect(upsertWorkingTarget(list, { ...explicit, branch: "fix/x", registered_at: 3 })).toEqual([{ ...explicit, branch: "fix/x", registered_at: 3 }]);
  });

  it("keeps the newest registrations within the limit", () => {
    let list: ReturnType<typeof upsertWorkingTarget> = [];
    for (let i = 0; i <= MAX_WORKING_TARGETS; i++) {
      list = upsertWorkingTarget(list, { repo: resolve(`fixture/r${i}`), branch: "main", source: "explicit", registered_at: i });
    }
    expect(list).toHaveLength(MAX_WORKING_TARGETS);
    expect(list[0]!.repo).toBe(resolve("fixture/r1"));
  });
});
