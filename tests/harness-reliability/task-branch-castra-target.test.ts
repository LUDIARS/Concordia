import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import {
  castraTargetRegistration, displayedTargetProject, requiresTaskBranchCheck, resolveTargetProjectPath, returnCommand,
} from "../../src/harness/reliability/task-branch-policy.js";
import type { BranchSnapshot } from "../../src/harness/reliability/task-branch-git.js";
import { makeTestDb } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";

/**
 * TB-CASTRA / TB-CD: 2026-11-16 MemoriaForChild の実例 (6 回連続拒否)。
 * Castra root 起点のセッションが別リポ (MemoriaForChild) の linked worktree で作業し、target_project には
 * プロジェクト名 "Concordia" が入っていた。castra 照合は Cc プロセスの cwd 基準の存在しないパス
 * (<cwd>/Concordia) で行われ、拒否文が案内した `cd <登録 checkout>` も拒否されて抜けられなかった。
 */
describe("Castra-root session working in another repository's linked worktree (2026-11-16)", () => {
  const branch = "feat/mf-incident-records";
  const root = resolve("fixture/ars"), mf = resolve("fixture/ars/MemoriaForChild");
  const mfWt = resolve("fixture/ars/MemoriaForChild-feat-mf-incident-records"), cc = resolve("fixture/ars/Concordia");
  const mfCommon = join(mf, ".git");
  const snapshots: Record<string, BranchSnapshot> = {
    [root]: { repo: root, branch: "main", mainExists: true, commonDir: join(root, ".git"), checkouts: [{ repo: root, branch: "main" }] },
    [mf]: { repo: mf, branch: "main", mainExists: true, commonDir: mfCommon,
      checkouts: [{ repo: mf, branch: "main" }, { repo: mfWt, branch }] },
    [mfWt]: { repo: mfWt, branch, mainExists: true, commonDir: mfCommon },
    [cc]: { repo: cc, branch: "main", mainExists: true, commonDir: join(cc, ".git"), checkouts: [{ repo: cc, branch: "main" }] },
  };
  const projects = [
    { code: "Cc", project: "Concordia", repo_path: cc },
    { code: "Mf", project: "MemoriaForChild", repo_path: mf.replace(/\\/g, "/") },
    { code: "Gone", project: "Gone", repo_path: resolve("fixture/ars/Gone") },
  ];
  const existing = new Set([root, mf, mfWt, cc].map(path => resolve(path)));
  const exists = (path: string) => existing.has(resolve(path));

  function setup(targetProject: string) {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    sessions.insertSession({ id: "mf-incident", provider: "claude-code", repo_path: root, repo_origin: null, branch,
      host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null, target_project: targetProject });
    const service = new TaskBranchService(sessions, async (cwd) => {
      const snapshot = snapshots[resolve(cwd)];
      if (!snapshot) throw new Error(`not a fixture checkout: ${cwd}`);
      return snapshot;
    }, undefined, undefined, () => [root], () => projects, exists);
    const gate = (action: { tool: string; command?: string; cwd: string; filePath?: string }) => service.gate("mf-incident", action);
    return { gate, close: () => db.close() };
  }

  it("(a) the lone cd the denial names passes the gate, and so does cd to the Castra root", async () => {
    const { gate, close } = setup("Concordia");
    try {
      const denied = await gate({ tool: "Bash", command: "npm test", cwd: mfWt });
      expect(denied?.rule).toBe("task-branch");
      const back = returnCommand({ repo: root });
      expect(denied?.suggestion).toContain(back);
      expect(requiresTaskBranchCheck({ tool: "Bash", command: back, cwd: mfWt })).toBe(false);
      expect(await gate({ tool: "Bash", command: back, cwd: mfWt })).toBeNull();
      expect(await gate({ tool: "Bash", command: "cd E:/Document/Ars", cwd: mfWt })).toBeNull();
      // Editing the unregistered checkout is still denied.
      expect((await gate({ tool: "Edit", cwd: mfWt, filePath: join(mfWt, "a.ts") }))?.decision).toBe("deny");
    } finally { close(); }
  });

  it("(b) castra_registration is never a non-existent cwd-relative path", async () => {
    const { gate, close } = setup("Concordia");
    try {
      await gate({ tool: "Bash", command: "npm test", cwd: mfWt });
      const repeated = await gate({ tool: "Bash", command: "npm test", cwd: mfWt });
      expect(repeated?.reason).toContain("同じ拒否が 2 回");
      const values = JSON.parse(repeated!.reason.slice(repeated!.reason.indexOf("{"))) as { castra_registration: unknown };
      // "Concordia" resolves to the registered repo, which does not hold the branch, so it is reported as such.
      expect(values.castra_registration).toEqual({ repo: cc, branch });
      expect(repeated?.reason).not.toContain(join(process.cwd(), "Concordia"));
    } finally { close(); }
  });

  it("shows the acting worktree's repository as the inferred target (display only)", async () => {
    const { gate, close } = setup("Concordia");
    try {
      const denied = await gate({ tool: "Bash", command: "npm test", cwd: mfWt });
      expect(denied?.decision).toBe("deny");
      expect(denied?.reason).toContain(`推定対象: ${mf}`);
    } finally { close(); }
  });

  it("matches the work in the target repository when target_project is its project code", async () => {
    const { gate, close } = setup("Mf");
    try {
      expect(await gate({ tool: "Bash", command: "npm test", cwd: mfWt })).toBeNull();
      expect(await gate({ tool: "Edit", cwd: mfWt, filePath: join(mfWt, "a.ts") })).toBeNull();
      expect((await gate({ tool: "Edit", cwd: mf, filePath: join(mf, "a.ts") }))?.decision).toBe("deny");
    } finally { close(); }
  });

  it("resolves target_project through the project registration, or skips the Castra re-check", () => {
    const session = (target: string) => ({ repo_path: root, branch, target_project: target });
    const resolver = (target: string) => resolveTargetProjectPath(target, projects, exists);
    expect(castraTargetRegistration(session("Concordia"), [root], resolver)).toEqual({ repo: cc, branch });
    expect(castraTargetRegistration(session("concordia"), [root], resolver)).toEqual({ repo: cc, branch });
    expect(castraTargetRegistration(session("Mf"), [root], resolver)).toEqual({ repo: mf, branch });
    // Codes are case-sensitive; an unregistered name or a registered path that does not exist is skipped.
    expect(castraTargetRegistration(session("mf"), [root], resolver)).toBeNull();
    expect(castraTargetRegistration(session("Unknown"), [root], resolver)).toBeNull();
    expect(castraTargetRegistration(session("Gone"), [root], resolver)).toBeNull();
    // Without project registrations a bare name is not resolved against the process cwd.
    expect(castraTargetRegistration(session("Concordia"), [root])).toBeNull();
    // An absolute target_project keeps working as before.
    expect(castraTargetRegistration(session(mf), [root])).toEqual({ repo: mf, branch });
    expect(castraTargetRegistration(session(mf), [root], resolver)).toEqual({ repo: mf, branch });
    expect(resolveTargetProjectPath(resolve("fixture/not-there"), projects, exists)).toBe(resolve("fixture/not-there"));
  });

  it("changes the inferred target only for a Castra-root session in another repository's linked worktree", () => {
    const primary = { repo: root, branch };
    const acting = { repo: mfWt, branch, commonDir: mfCommon };
    expect(displayedTargetProject({ primary, acting, targetProject: "Concordia", workspaceRoots: [root] })).toBe(mf);
    // A different branch, a non-root primary, the main checkout itself or a submodule keep target_project.
    expect(displayedTargetProject({ primary, acting: { ...acting, branch: "main" }, targetProject: "Concordia", workspaceRoots: [root] })).toBe("Concordia");
    expect(displayedTargetProject({ primary: { repo: cc, branch }, acting, targetProject: "Concordia", workspaceRoots: [root] })).toBe("Concordia");
    expect(displayedTargetProject({ primary, acting: { repo: mf, branch, commonDir: mfCommon }, targetProject: "Concordia", workspaceRoots: [root] })).toBe("Concordia");
    expect(displayedTargetProject({ primary, acting: { ...acting, commonDir: join(root, ".git", "modules", "x") }, targetProject: "Concordia", workspaceRoots: [root] })).toBe("Concordia");
    expect(displayedTargetProject({ primary, acting: { ...acting, commonDir: join(root, ".git") }, targetProject: null, workspaceRoots: [root] })).toBeNull();
  });
});
