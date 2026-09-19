import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { readBranchSnapshot } from "../../src/harness/reliability/task-branch-git.js";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import { checkNewBranchCommand, requiresTaskBranchCheck } from "../../src/harness/reliability/task-branch-policy.js";
import { evaluateCachedAction, type LocalPolicySnapshot } from "../../src/harness/supervisor-policy.js";
import { ReliabilityHookService } from "../../src/harness/reliability/hook-service.js";
import { makeReliabilityFixture } from "./fixture.js";
import { makeTestDb } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { StatsRepo } from "../../src/db/stats-repo.js";
import { PrRecordsRepo } from "../../src/db/pr-records-repo.js";
import { startPrIngestWatcher } from "../../src/pr/ingest.js";

describe("task branch adapters", () => {
  it("checks opaque shell writes while allowing main-based worktree recovery", () => {
    expect(requiresTaskBranchCheck({ tool: "Bash", command: "node edit-files.mjs" })).toBe(true);
    expect(requiresTaskBranchCheck({ tool: "Bash", command: "git status; node edit-files.mjs" })).toBe(true);
    expect(requiresTaskBranchCheck({ tool: "Bash", command: "git worktree add -b feature/new ../new main" })).toBe(false);
    expect(checkNewBranchCommand("git -C repo worktree add -b feature/new ../new HEAD")?.decision).toBe("deny");
    expect(checkNewBranchCommand("git switch -c feature/new")?.decision).toBe("deny");
    expect(checkNewBranchCommand("git switch -c feature/new main")).toBeNull();
  });

  it("does not use an offline pre-PR snapshot as edit permission", () => {
    const snapshot: LocalPolicySnapshot = { version: 1, capturedAt: 1, repo: "/repo", branch: "feature/x",
      sessionId: "s", context: {}, policy: { ddd: false, contract: false }, mainPushAllowlist: [],
      strongImplModels: [], editedRepos: [], editedFiles: [], taskBranchLiveRequired: true };
    expect(evaluateCachedAction({ tool: "Edit", cwd: "/repo", branch: "feature/x" }, snapshot).blocked).toBe(true);
  });

  it("reads the checkout instead of trusting the caller's branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-branch-git-"));
    const linked = join(dir, "..", `${basename(dir)}-wt`);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
    try {
      git(["init", "-b", "main"]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
      git(["switch", "-c", "feature/actual", "main"]);
      git(["worktree", "add", "-b", "feature/linked", linked, "main"]);
      const primary = await readBranchSnapshot(dir);
      expect(primary).toMatchObject({ repo: resolve(dir), branch: "feature/actual", mainExists: true });
      const secondary = await readBranchSnapshot(linked);
      expect(secondary).toMatchObject({ repo: resolve(linked), branch: "feature/linked", commonDir: primary.commonDir });
      expect(primary.checkouts?.map(checkout => checkout.branch).sort()).toEqual(["feature/actual", "feature/linked"]);
    } finally {
      rmSync(linked, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
    // Several real Git processes need startup headroom under parallel review (same as conflux.test.ts).
  }, 60_000);

  it("runs the branch check for human ingress, not an automatic followup or duplicate hook", () => {
    const f = makeReliabilityFixture();
    const check = vi.fn(() => "branch warning");
    const service = new ReliabilityHookService({ sessions: f.sessions, messages: f.messages, store: f.store,
      pendingQuestions: () => [], acceptanceManifest: () => null, notify: f.notify, assess: f.assess,
      now: f.now, random: () => 0.9, checkTaskBranch: check });
    service.handle(f.id, { event: "prompt", event_id: "auto", prompt: "[automatic] continue" });
    expect(check).not.toHaveBeenCalled();
    f.messages.upsert({ session_id: f.id, ts: f.now() / 1000, author_type: "user", author_label: "human",
      author_platform: "discord", content: "Change UI colors" });
    const input = { event: "prompt" as const, event_id: "human", prompt: "Change UI colors" };
    expect(service.handle(f.id, input).context).toContain("branch warning");
    service.handle(f.id, input);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("records only the matching GitHub PR and does not reset on repeated ingestion", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db), stats = new StatsRepo(db), prs = new PrRecordsRepo(db);
    sessions.insertSession({ id: "pr-test", provider: "claude-code", repo_path: resolve("fixture"),
      repo_origin: "https://github.com/owner/game.git", branch: "feature/game", host: "test",
      started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
    sessions.patchSession("pr-test", { current_task: "game" });
    const watcher = startPrIngestWatcher({ sessions, stats, prs });
    try {
      stats.insert({ session_id: "pr-test", ts: 2, payload: { open_prs: [
        { repo: "owner/other", number: 1, branch: "feature/game" },
        { repo: "owner/game", number: 2, branch: "feature/game" },
      ] } });
      watcher.handle({ type: "stat.collected", session_id: "pr-test", stat_id: 1, ts: 2 });
      const service = new TaskBranchService(sessions);
      expect(service.read("pr-test")?.pr).toBe("https://github.com/owner/game/pull/2");
      const expected = service.beginClassification("pr-test");
      service.classify("pr-test", expected, "same-task");
      watcher.handle({ type: "stat.collected", session_id: "pr-test", stat_id: 1, ts: 3 });
      expect(service.read("pr-test")?.relation).toBe("same-task");
    } finally { watcher.stop(); db.close(); }
  });
});


describe("immediate GitHub submission observation", () => {
  it("accepts successful creation only for the current repository and explicit head", async () => {
    const { githubSubmission } = await import("../../src/harness/reliability/task-branch-submission.js");
    const input = { command: "gh pr create --head feature/x", message: "https://github.com/LUDIARS/Fixture/pull/42", failed: false, repoOrigin: "LUDIARS/Fixture", branch: "feature/x" };
    expect(githubSubmission(input)).toBe(input.message);
    expect(githubSubmission({ ...input, failed: true })).toBeNull();
    expect(githubSubmission({ ...input, command: "gh pr create --head feature/other" })).toBeNull();
    expect(githubSubmission({ ...input, repoOrigin: "LUDIARS/Other" })).toBeNull();
    expect(githubSubmission({ ...input, command: "echo quoted-url" })).toBeNull();
  });
});
