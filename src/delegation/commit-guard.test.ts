import { describe, it, expect } from "vitest";
import { checkCommitAllowed, MAX_CHANGED_FILES, type CommitGuardInput } from "./commit-guard.js";

const WORKSPACE = process.platform === "win32" ? "E:\\Document\\Ars" : "/ws";
const REPO = process.platform === "win32" ? "E:\\Document\\Ars\\Memoria" : "/ws/Memoria";

function input(overrides: Partial<CommitGuardInput> = {}): CommitGuardInput {
  return {
    runCwd: REPO,
    runBranch: "feat/x",
    repoRoot: REPO,
    currentBranch: "feat/x",
    changedPaths: ["server/a.ts"],
    forbiddenRoots: [WORKSPACE],
    ...overrides,
  };
}

describe("checkCommitAllowed", () => {
  it("run が所有する worktree の feature branch なら許可", () => {
    expect(checkCommitAllowed(input())).toEqual({ ok: true });
  });

  it("spawn_cwd が無い run は拒否 (所有する worktree が無い)", () => {
    const v = checkCommitAllowed(input({ runCwd: null }));
    expect(v).toMatchObject({ ok: false, code: "run_cwd_unknown" });
  });

  it("cwd がリポジトリ外なら拒否", () => {
    const other = process.platform === "win32" ? "E:\\Document\\Ars\\Other" : "/ws/Other";
    const v = checkCommitAllowed(input({ runCwd: other }));
    expect(v).toMatchObject({ ok: false, code: "cwd_outside_repo" });
  });

  it("ワークスペースルート (Castra) へのコミットは拒否", () => {
    const v = checkCommitAllowed(input({ runCwd: WORKSPACE, repoRoot: WORKSPACE }));
    expect(v).toMatchObject({ ok: false, code: "forbidden_root" });
  });

  it("main / master への直接コミットは拒否", () => {
    for (const branch of ["main", "master"]) {
      const v = checkCommitAllowed(input({ runBranch: branch, currentBranch: branch }));
      expect(v).toMatchObject({ ok: false, code: "protected_branch" });
    }
  });

  it("detached HEAD は拒否", () => {
    const v = checkCommitAllowed(input({ runBranch: null, currentBranch: "HEAD" }));
    expect(v).toMatchObject({ ok: false, code: "detached_head" });
  });

  it("起動時と別ブランチに移っていたら拒否", () => {
    const v = checkCommitAllowed(input({ currentBranch: "feat/other" }));
    expect(v).toMatchObject({ ok: false, code: "branch_mismatch" });
  });

  it("spawn_branch が無ければ現在ブランチを採用する", () => {
    expect(checkCommitAllowed(input({ runBranch: null, currentBranch: "feat/any" }))).toEqual({ ok: true });
  });

  it("変更が無ければ拒否", () => {
    const v = checkCommitAllowed(input({ changedPaths: [] }));
    expect(v).toMatchObject({ ok: false, code: "nothing_to_commit" });
  });

  it("変更ファイルが上限を超えたら拒否 (暴走コミットを人間に見せる)", () => {
    const many = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, i) => `f${i}.ts`);
    const v = checkCommitAllowed(input({ changedPaths: many }));
    expect(v).toMatchObject({ ok: false, code: "too_many_changes" });
  });

  it("cwd が worktree のサブディレクトリでも許可 (repoRoot 配下)", () => {
    const sub = process.platform === "win32" ? `${REPO}\\server` : `${REPO}/server`;
    expect(checkCommitAllowed(input({ runCwd: sub }))).toEqual({ ok: true });
  });
});
