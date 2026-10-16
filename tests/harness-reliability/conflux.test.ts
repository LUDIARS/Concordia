import { describe, it, expect, vi } from "vitest";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { makeTestDb, makeTestDir } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { ProjectCodesRepo } from "../../src/db/project-codes-repo.js";
import { ConfluxService } from "../../src/harness/reliability/conflux-service.js";
import { parseConfluxSelection, switchObstacle } from "../../src/harness/reliability/conflux-policy.js";
import { inspectConfluxGit, switchConfluxGit, type ConfluxGitState } from "../../src/harness/reliability/conflux-git.js";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import { harnessConfluxRouter } from "../../src/api/harness-conflux.js";
import { confluxFixtureGitArgs } from "./conflux-fixture-git.js";
const selection = { projectCode: "KD", tide: "speed", variant: "light", baseBranch: "evolution/speed/light/main", workBranch: "feature/speed/light/scoring" };
function fixture() {
  const db = makeTestDb(); const sessions = new SessionsRepo(db); const projects = new ProjectCodesRepo(db);
  const repo = resolve("fixture-conflux");
  projects.register({ code: "KD", project: "Fixture", repoPath: repo, repoOrigin: "LUDIARS/Fixture", addedBy: "fixture" });
  projects.setRevisorWorkflow("KD", "github"); projects.update("KD", { confluxFlow: true });
  sessions.insertSession({ id: "cf", provider: "claude-code", repo_path: repo, repo_origin: "LUDIARS/Fixture",
    branch: "feature/old", host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: '{}' });
  const state: ConfluxGitState = { repo, branch: "feature/old", dedicated: true, dirty: false, baseExists: true, workExists: false, descends: false };
  const inspect = vi.fn(async () => ({ ...state }));
  const change = vi.fn(async () => { Object.assign(state, { branch: selection.workBranch, workExists: true, descends: true }); });
  const service = new ConfluxService(sessions, projects, inspect, change);
  return { db, sessions, projects, state, inspect, change, service, action: { tool: "Edit", cwd: repo } };
}
describe("Conflux work isolation", () => {
  it("requires a matching selection and leaves the review workflow independent", async () => {
    const f = fixture();
    expect(f.projects.findByCode("KD")?.revisor_workflow).toBe("github");
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.change).not.toHaveBeenCalled();
    expect(() => f.service.select("cf", { ...selection, projectCode: "Mp" })).toThrow();
    f.projects.update("KD", { confluxFlow: false });
    expect((await f.service.gate("cf", f.action)).active).toBe(false);
    expect(f.projects.findByCode("KD")?.revisor_workflow).toBe("github");
  });
  it("switches a clean dedicated worktree and blocks the original edit for retry", async () => {
    const f = fixture(); f.service.select("cf", selection);
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.change).toHaveBeenCalledOnce();
    expect(f.sessions.findSession("cf")?.branch).toBe(selection.workBranch);
    expect((await f.service.gate("cf", f.action)).hit).toBeNull();
  });
  it.each([{ dirty: true }, { dedicated: false }, { baseExists: false }, { workExists: true, descends: false }])("preserves an unsafe checkout %j", async patch => {
    const f = fixture(); Object.assign(f.state, patch); f.service.select("cf", selection);
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.change).not.toHaveBeenCalled();
    expect(f.sessions.findSession("cf")?.branch).toBe("feature/old");
  });
  it("does not switch another active session's checkout", async () => {
    const f = fixture(); f.service.select("cf", selection);
    f.sessions.insertSession({ id: "peer", provider: "claude-code", repo_path: f.state.repo, repo_origin: "LUDIARS/Fixture",
      branch: "feature/old", host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: '{}' });
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny"); expect(f.change).not.toHaveBeenCalled();
  });
  it("does not grant edit permission when switching fails", async () => {
    const f = fixture(); f.service.select("cf", selection); f.change.mockRejectedValueOnce(new Error("used elsewhere"));
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.sessions.findSession("cf")?.branch).toBe("feature/old");
  });
  it("preserves the submitted task boundary after successful flow matching", async () => {
    const f = fixture(); f.service.select("cf", selection); await f.service.gate("cf", f.action);
    const tasks = new TaskBranchService(f.sessions, async () => ({ repo: f.state.repo, branch: f.state.branch, mainExists: true }), (id, action) => f.service.gate(id, action));
    tasks.submitted("cf", { repo: f.state.repo, branch: f.state.branch }, "pr-1");
    f.sessions.patchSession("cf", { current_task: "unrelated work" });
    expect((await tasks.gate("cf", f.action))?.rule).toBe("submitted-task-boundary");
  });
  it("offers selection through the harness API without claiming checkout success", async () => {
    const f = fixture(); const app = harnessConfluxRouter(f.service);
    const response = await app.request("/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "cf", selection }) });
    expect(await response.json()).toEqual({ selected: true, checked: false }); expect(f.change).not.toHaveBeenCalled();
  });
  it("accepts either explicit main naming and rejects cross-flow or shell names", () => {
    expect(parseConfluxSelection(selection)).toEqual(selection);
    expect(parseConfluxSelection({ ...selection, baseBranch: "evolution/speed/light" })).not.toBeNull();
    expect(parseConfluxSelection({ ...selection, workBranch: "feature/other/light/task" })).toBeNull();
    expect(parseConfluxSelection({ ...selection, tide: "speed;echo" })).toBeNull();
    expect(switchObstacle({ dedicated: true, peers: false, dirty: true })).not.toBeNull();
  });
  it("creates from the selected local base and detects dirty state using real Git", async () => {
    const dir = makeTestDir("conflux-git-");
    const hooks = makeTestDir("conflux-hooks-");
    const externalHooks = makeTestDir("conflux-external-hooks-");
    const marker = join(externalHooks, "invoked");
    // A sentinel proves the inherited path is executable before isolation is applied.
    for (const name of ["pre-commit", "post-checkout"]) {
      const hook = join(externalHooks, name);
      writeFileSync(hook, '#!/bin/sh\nprintf invoked > "$(dirname "$0")/invoked"\nexit 1\n');
      chmodSync(hook, 0o755);
    }
    const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: externalHooks };
    const before = { ...process.env };
    const execute = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true }).trim();
    const git = (args: string[]) => execute(dir, confluxFixtureGitArgs(args, hooks));
    const fixtureGit = async (cwd: string, args: string[]) => execute(cwd, confluxFixtureGitArgs(args, hooks));
    git(["init", "-b", "main"]);
    expect(execute(dir, ["config", "--get", "core.hooksPath"])).toBe(externalHooks);
    expect(() => execute(dir, ["hook", "run", "pre-commit"])).toThrow();
    expect(existsSync(marker)).toBe(true);
    // Remove only the sentinel file; subsequent operations must never recreate it.
    unlinkSync(marker);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
    expect(existsSync(marker)).toBe(false);
    git(["branch", selection.baseBranch]); const wt = join(dir, "work"); git(["worktree", "add", "-b", "feature/old", wt, "main"]);
    expect(existsSync(marker)).toBe(false);
    const inspect = async (cwd: string) => {
      try {
        return await inspectConfluxGit(cwd, selection, fixtureGit);
      } catch (cause) {
        const error = cause as Error & { code?: string | number; signal?: string; killed?: boolean; stderr?: string };
        throw new Error(`Conflux fixture inspection failed: ${JSON.stringify({
          cwd, code: error.code, signal: error.signal, killed: error.killed, stderr: error.stderr,
        })}`, { cause });
      }
    };
    expect((await inspect(dir)).dedicated).toBe(false);
    expect((await inspect(wt)).dedicated).toBe(true);
    await switchConfluxGit(wt, selection, false, fixtureGit);
    expect(existsSync(marker)).toBe(false);
    expect(await inspect(wt)).toMatchObject({ branch: selection.workBranch, descends: true, dirty: false });
    await fixtureGit(wt, ["switch", "feature/old"]);
    await switchConfluxGit(wt, selection, true, fixtureGit);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(wt, "pending.txt"), "preserve");
    expect((await inspect(wt)).dirty).toBe(true);
    expect(process.env).toEqual(before);
    expect(env.GIT_CONFIG_VALUE_0).toBe(externalHooks);
    // Multiple real Git inspections need process-startup headroom under parallel review.
  }, 60_000);
});
