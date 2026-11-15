import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import { requiresTaskBranchCheck, returnCommand } from "../../src/harness/reliability/task-branch-policy.js";
import { isRecoveryCd, recoveryCdTarget } from "../../src/harness/reliability/task-branch-recovery.js";
import { isClaudeWorkArea } from "../../src/harness/work-area.js";
import type { BranchSnapshot } from "../../src/harness/reliability/task-branch-git.js";
import { makeTestDb } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";

/**
 * TB-CD: 2026-11-12 実例。Castra root (main) 登録のセッションが `git:worktree` で linked worktree を作り、
 * Bash の cwd がそこへ移った。commonDir が同じなので同一リポジトリ扱いになり、branch 不一致で
 * `cd <Castra root>` まで拒否され、戻る手段が無くなった。
 */
describe("a session parked in a linked worktree can always cd back (TB-CD)", () => {
  const root = resolve("fixture/ars"), worktree = resolve("fixture/ars/.wt-Castra-raw-network");
  const other = resolve("fixture/unregistered"), castraTarget = resolve("fixture/ars/Concordia/Ars");
  const commonDir = resolve("fixture/ars/.git");
  const snapshots: Record<string, BranchSnapshot> = {
    [root]: { repo: root, branch: "main", mainExists: true, commonDir,
      checkouts: [{ repo: root, branch: "main" }, { repo: worktree, branch: "fix/harness-raw-network-script" }] },
    [worktree]: { repo: worktree, branch: "fix/harness-raw-network-script", mainExists: true, commonDir },
    [other]: { repo: other, branch: "main", mainExists: true, commonDir: resolve("fixture/unregistered/.git"),
      checkouts: [{ repo: other, branch: "main" }] },
  };

  function setup() {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    // 実例の判定値: primary = Castra root @ main、target_project = Ars、working_targets 無し。
    sessions.insertSession({ id: "cd-back", provider: "claude-code", repo_path: root, repo_origin: null, branch: "main",
      host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null, target_project: castraTarget });
    const service = new TaskBranchService(sessions, async (cwd) => {
      const snapshot = snapshots[resolve(cwd)];
      if (!snapshot) throw new Error(`not a fixture checkout: ${cwd}`);
      return snapshot;
    }, undefined, undefined, () => [root]);
    const gate = (action: { tool: string; command?: string; cwd: string; filePath?: string }) => service.gate("cd-back", action);
    return { gate, close: () => db.close() };
  }

  it("lets a lone cd to the registered checkout through from the worktree", async () => {
    const { gate, close } = setup();
    try {
      expect(await gate({ tool: "Bash", command: `cd ${root}`, cwd: worktree })).toBeNull();
      expect(await gate({ tool: "Bash", command: `cd "${root.replace(/\\/g, "/")}"`, cwd: worktree })).toBeNull();
      expect(await gate({ tool: "Bash", command: `cd '${root}${process.platform === "win32" ? "\\" : "/"}'`, cwd: worktree })).toBeNull();
      expect(await gate({ tool: "PowerShell", command: `Set-Location "${root}"`, cwd: worktree })).toBeNull();
      // 戻ったあとは登録どおりなので通常のコマンドも通る。
      expect(await gate({ tool: "Bash", command: "git log --oneline -1", cwd: root })).toBeNull();
    } finally { close(); }
  });

  it("names the return command in the denial, and that command passes", async () => {
    const { gate, close } = setup();
    try {
      const denied = await gate({ tool: "Bash", command: "node build.mjs", cwd: worktree });
      expect(denied?.rule).toBe("task-branch");
      const command = returnCommand({ repo: root });
      expect(denied?.suggestion).toContain(command);
      expect(await gate({ tool: "Bash", command, cwd: worktree })).toBeNull();
    } finally { close(); }
  });

  it("keeps denying anything other than a lone cd back", async () => {
    const { gate, close } = setup();
    try {
      expect((await gate({ tool: "Bash", command: "node build.mjs", cwd: worktree }))?.decision).toBe("deny");
      expect((await gate({ tool: "Bash", command: `cd ${root} && git commit -m x`, cwd: worktree }))?.decision).toBe("deny");
      expect((await gate({ tool: "Bash", command: `cd ${root}; rm -rf x`, cwd: worktree }))?.decision).toBe("deny");
      expect((await gate({ tool: "Bash", command: `cd ${other}`, cwd: worktree }))?.decision).toBe("deny");
      expect((await gate({ tool: "Bash", command: "cd -", cwd: worktree }))?.decision).toBe("deny");
    } finally { close(); }
  });

  it("still denies Edit and Write in the unregistered worktree, even with a cd-shaped command", async () => {
    const { gate, close } = setup();
    try {
      expect((await gate({ tool: "Edit", cwd: worktree, filePath: join(worktree, "a.ts") }))?.decision).toBe("deny");
      expect((await gate({ tool: "Write", cwd: worktree, filePath: join(worktree, "a.ts") }))?.decision).toBe("deny");
      expect((await gate({ tool: "Edit", command: `cd ${root}`, cwd: worktree }))?.decision).toBe("deny");
    } finally { close(); }
  });

  it("parses only a single absolute or cwd-relative cd", () => {
    expect(recoveryCdTarget(`cd ${root}`, worktree)).toBe(root);
    expect(recoveryCdTarget("cd ..", worktree)).toBe(resolve(worktree, ".."));
    expect(recoveryCdTarget("cd", worktree)).toBeNull();
    expect(recoveryCdTarget("cd ~", worktree)).toBeNull();
    expect(recoveryCdTarget(`cd $HOME`, worktree)).toBeNull();
    expect(recoveryCdTarget(`cd ${root} extra`, worktree)).toBeNull();
    expect(isRecoveryCd(`cd ${root}`, worktree, [""])).toBe(false);
    if (process.platform === "win32") {
      expect(recoveryCdTarget("cd /e/Document/Ars", undefined)).toBe(resolve("E:/Document/Ars"));
      expect(isRecoveryCd("cd e:/document/ars", undefined, ["E:\\Document\\Ars"])).toBe(true);
    }
  });

  it("does not exempt cd from the check itself: the policy decides it per destination", () => {
    expect(requiresTaskBranchCheck({ tool: "Bash", command: `cd ${root}`, cwd: worktree })).toBe(true);
  });
});

/** TB-WORKAREA: Claude Code の session scratchpad と project memory は git 管理外の作業領域。 */
describe("Claude work areas outside any repository (TB-WORKAREA)", () => {
  const tmp = resolve("fixture/Temp"), config = resolve("fixture/home/.claude");
  const bases = { tmpDirs: [tmp], claudeConfigDirs: [config] };

  it("recognises the session scratchpad and the project memory dir", () => {
    expect(isClaudeWorkArea(join(tmp, "claude", "0f476dd2ba83293a", "9e676d33", "scratchpad", "a.json"), bases)).toBe(true);
    expect(isClaudeWorkArea(join(tmp, "claude", "0f476dd2ba83293a", "9e676d33", "scratchpad"), bases)).toBe(true);
    expect(isClaudeWorkArea(join(config, "projects", "E--Document-Ars-Concordia", "memory", "MEMORY.md"), bases)).toBe(true);
  });

  it("keeps every other path outside a repository fail-closed", () => {
    expect(isClaudeWorkArea(join(tmp, "a.json"), bases)).toBe(false);
    expect(isClaudeWorkArea(join(tmp, "claude", "x", "y", "not-scratch", "a.json"), bases)).toBe(false);
    expect(isClaudeWorkArea(join(tmp, "claude", "x", "scratchpad", "a.json"), bases)).toBe(false);
    expect(isClaudeWorkArea(join(config, "settings.json"), bases)).toBe(false);
    expect(isClaudeWorkArea(join(config, "projects", "slug", "transcript.jsonl"), bases)).toBe(false);
    expect(isClaudeWorkArea(join(config, "projects", "slug", "memory", "..", "..", "..", "settings.json"), bases)).toBe(false);
    expect(isClaudeWorkArea(resolve("fixture/elsewhere/projects/slug/memory/a.md"), bases)).toBe(false);
  });
});
