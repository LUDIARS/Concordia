import { describe, expect, it } from "vitest";
import { decideDeclaredTargetPatch, sessionWorkingRepoPath, type DeclaredTargetIo } from "./session-working-repo.js";

function io(branches: Record<string, string | null> = {}, keys: Record<string, string> = {}): DeclaredTargetIo {
  return {
    repoKey: async (path) => keys[path] ?? path,
    currentBranch: async (path) => branches[path] ?? null,
  };
}

const session = { repo_path: "D:/w/Concordia", target_project: "D:/w/Concordia" };

describe("sessionWorkingRepoPath", () => {
  it("宣言された target_project を優先する", () => {
    expect(sessionWorkingRepoPath({ repo_path: "D:/w", target_project: "D:/w/Concordia" })).toBe("D:/w/Concordia");
  });

  it("未宣言・空白なら repo_path", () => {
    expect(sessionWorkingRepoPath({ repo_path: "D:/w/Revisor", target_project: null })).toBe("D:/w/Revisor");
    expect(sessionWorkingRepoPath({ repo_path: "D:/w/Revisor", target_project: "  " })).toBe("D:/w/Revisor");
  });
});

describe("decideDeclaredTargetPatch", () => {
  it("作業対象外のリポへの repo_path 更新は repo_path / repo_origin / branch を落とす", async () => {
    const decision = await decideDeclaredTargetPatch(session, { repo_path: "D:/w/Revisor", repo_origin: "o" }, io());
    expect(decision).toEqual({ drop: ["repo_path", "repo_origin", "branch"], reason: "outside_target_repo" });
  });

  it("作業対象の worktree への移動は通す", async () => {
    const keys = { "D:/w/.wt-Concordia-x": "D:/w/Concordia" };
    const decision = await decideDeclaredTargetPatch(session, { repo_path: "D:/w/.wt-Concordia-x" }, io({}, keys));
    expect(decision.reason).toBeNull();
  });

  it("target_project を同時に変える更新は作業対象の付け替えなので通す", async () => {
    const decision = await decideDeclaredTargetPatch(session, { repo_path: "D:/w/Revisor", target_project: "D:/w/Revisor" }, io());
    expect(decision.reason).toBeNull();
  });

  it("target_project 未宣言のセッションは従来どおり", async () => {
    const decision = await decideDeclaredTargetPatch({ repo_path: "D:/w", target_project: null }, { repo_path: "D:/w/Revisor" }, io());
    expect(decision.reason).toBeNull();
  });

  it("branch だけの更新は作業リポの実 branch と違えば落とす", async () => {
    const decision = await decideDeclaredTargetPatch(session, { branch: "main" }, io({ "D:/w/Concordia": "feat/x" }));
    expect(decision).toEqual({ drop: ["branch"], reason: "branch_not_checked_out" });
  });

  it("branch だけの更新は実 branch と一致すれば通す", async () => {
    const decision = await decideDeclaredTargetPatch(session, { branch: "feat/x" }, io({ "D:/w/Concordia": "feat/x" }));
    expect(decision.reason).toBeNull();
  });

  it("作業リポがまだ Castra root の間は branch を照合しない", async () => {
    const castra = { repo_path: "D:/w", target_project: "D:/w/Concordia" };
    const decision = await decideDeclaredTargetPatch(castra, { branch: "feat/x" }, io({ "D:/w": "main" }));
    expect(decision.reason).toBeNull();
  });

  it("実 branch を読めないとき・I/O が失敗したときは通す", async () => {
    expect((await decideDeclaredTargetPatch(session, { branch: "feat/x" }, io())).reason).toBeNull();
    const failing: DeclaredTargetIo = { repoKey: async () => { throw new Error("io"); }, currentBranch: async () => null };
    expect((await decideDeclaredTargetPatch(session, { repo_path: "D:/w/Revisor" }, failing)).reason).toBeNull();
  });
});
