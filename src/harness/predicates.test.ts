import { describe, it, expect } from "vitest";
import {
  noMainPush,
  makeNoMainPushPredicate,
  withMainPushAllowlist,
  DEFAULT_PREDICATES,
  branchBeforeEdit,
  maxReposWarn,
  outsideScope,
  privateTeamPublication,
  repoLeaf,
  teamWorktreeRestriction,
  MAX_REPOS,
  type HarnessAction,
} from "./predicates.js";

const base: HarnessAction = { tool: "Bash" };

describe("noMainPush", () => {
  it("現在ブランチが main で ref 省略の push を deny", () => {
    const hit = noMainPush({ tool: "Bash", command: "git push", branch: "main" });
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("no-main-push");
  });

  it("origin main を明示した push を deny (ブランチ不問)", () => {
    expect(noMainPush({ tool: "Bash", command: "git push --force origin main", branch: "feat/x" })?.decision).toBe("deny");
    expect(noMainPush({ tool: "Bash", command: "git push origin HEAD:master" })?.decision).toBe("deny");
  });

  it("feature ブランチへの push は素通し", () => {
    expect(noMainPush({ tool: "Bash", command: "git push origin feat/x", branch: "feat/x" })).toBeNull();
    expect(noMainPush({ tool: "Bash", command: "git push", branch: "feat/x" })).toBeNull();
  });

  it("push でない git コマンド / 非 Bash は対象外", () => {
    expect(noMainPush({ tool: "Bash", command: "git status", branch: "main" })).toBeNull();
    expect(noMainPush({ tool: "Edit", filePath: "/a.ts", branch: "main" })).toBeNull();
  });

  it("Windows の大文字コマンドと完全修飾 main ref を deny", () => {
    expect(noMainPush({ tool: "Bash", command: "GIT PUSH ORIGIN MAIN", branch: "feat/x" })?.decision).toBe("deny");
    expect(noMainPush({
      tool: "Bash",
      command: "git push origin HEAD:refs/heads/main",
      branch: "feat/x",
    })?.decision).toBe("deny");
  });

  it("feature ブランチからの --all / --mirror も main を含むため deny", () => {
    expect(noMainPush({ tool: "Bash", command: "git push origin --all", branch: "feat/x" })?.decision).toBe("deny");
    expect(noMainPush({ tool: "Bash", command: "git push --mirror", branch: "feat/x" })?.decision).toBe("deny");
  });
});

describe("makeNoMainPushPredicate (許可リスト)", () => {
  const allowlisted = makeNoMainPushPredicate(["KuzuSurvivors", "MakaiNui"]);

  it("許可リポへの main push は deny せず warn で追跡する (git -C 形式)", () => {
    const hit = allowlisted({
      tool: "Bash",
      command: "git -C C:/repos/KuzuSurvivors push origin main",
      cwd: "C:/repos/Concordia",
      branch: "feat/x",
    });
    expect(hit?.decision).toBe("warn");
    expect(hit?.rule).toBe("main-push-allowlisted");
  });

  it("cwd が許可リポなら ref 省略の main push も warn", () => {
    const hit = allowlisted({ tool: "Bash", command: "git push", cwd: "C:\\repos\\KuzuSurvivors", branch: "main" });
    expect(hit?.decision).toBe("warn");
  });

  it("非許可リポは従来どおり deny", () => {
    const hit = allowlisted({ tool: "Bash", command: "git push origin main", cwd: "C:/repos/Figmentum", branch: "main" });
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("no-main-push");
  });

  it("許可リストが空なら既定述語と同じ (全リポ deny)", () => {
    const action: HarnessAction = { tool: "Bash", command: "git push origin main", cwd: "C:/repos/KuzuSurvivors" };
    expect(makeNoMainPushPredicate([])(action)?.decision).toBe("deny");
    expect(noMainPush(action)?.decision).toBe("deny");
  });

  it("push でないコマンドは許可リポでも対象外", () => {
    expect(allowlisted({ tool: "Bash", command: "git status", cwd: "/x/KuzuSurvivors", branch: "main" })).toBeNull();
  });

  it("allowlisted な decoy -C を含む複合コマンドは deny", () => {
    const hit = allowlisted({
      tool: "Bash",
      command: "git -C C:/repos/KuzuSurvivors status && git push origin main",
      cwd: "C:/repos/Figmentum",
      branch: "main",
    });
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("no-main-push");
  });

  it("inline alias 内の非許可リポ push を allowlist で迂回できない", () => {
    const hit = allowlisted({
      tool: "Bash",
      command: 'git -C C:/repos/KuzuSurvivors -c "alias.x=!git -C C:/repos/Figmentum push origin main" x',
      cwd: "C:/repos/Concordia",
      branch: "main",
    });
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("no-main-push");
  });

  it("`..` で許可リポ外へ出る push は deny", () => {
    const hit = allowlisted({
      tool: "Bash",
      command: "git -C C:/repos/KuzuSurvivors/../Figmentum push origin main",
      cwd: "C:/repos/Concordia",
      branch: "main",
    });
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("no-main-push");
  });
});

describe("withMainPushAllowlist", () => {
  const action: HarnessAction = { tool: "Bash", command: "git push origin main", cwd: "/x/KuzuSurvivors", branch: "main" };

  it("noMainPush だけを差し替え、他の述語は同一参照のまま", () => {
    const swapped = withMainPushAllowlist(["KuzuSurvivors"]);
    expect(swapped).toHaveLength(DEFAULT_PREDICATES.length);
    const noMainPushIndex = DEFAULT_PREDICATES.indexOf(noMainPush);
    expect(swapped[noMainPushIndex]).not.toBe(noMainPush);
    expect(swapped[noMainPushIndex]!(action)?.decision).toBe("warn");
    expect(swapped.filter((_, index) => index !== noMainPushIndex)).toEqual(DEFAULT_PREDICATES.filter((_, index) => index !== noMainPushIndex));
  });

  it("許可リストが空なら既定セットの複製 (従来判定)", () => {
    const same = withMainPushAllowlist([]);
    expect(same).toEqual(DEFAULT_PREDICATES);
    expect(same[DEFAULT_PREDICATES.indexOf(noMainPush)]!(action)?.decision).toBe("deny");
  });
});

describe("branchBeforeEdit", () => {
  it("main 上の編集を warn", () => {
    const hit = branchBeforeEdit({ tool: "Edit", filePath: "/repo/a.ts", branch: "main" });
    expect(hit?.decision).toBe("warn");
    expect(hit?.rule).toBe("branch-before-edit");
  });

  it("feature ブランチ上の編集は素通し", () => {
    expect(branchBeforeEdit({ tool: "Write", filePath: "/repo/a.ts", branch: "feat/x" })).toBeNull();
  });

  it("ブランチ不明なら強制しない (null)", () => {
    expect(branchBeforeEdit({ tool: "Edit", filePath: "/repo/a.ts" })).toBeNull();
  });

  it("編集系でないツールは対象外", () => {
    expect(branchBeforeEdit({ tool: "Bash", command: "ls", branch: "main" })).toBeNull();
  });
});

describe("maxReposWarn", () => {
  it("上限超過で warn", () => {
    const repos = Array.from({ length: MAX_REPOS + 1 }, (_, i) => `/repo/${i}`);
    const hit = maxReposWarn({ ...base, editedRepos: repos });
    expect(hit?.decision).toBe("warn");
    expect(hit?.rule).toBe("max-repos");
  });

  it("重複を除いて数える (上限以内なら null)", () => {
    const repos = ["/a", "/a", "/b", "/b", "/c"];
    expect(maxReposWarn({ ...base, editedRepos: repos })).toBeNull();
  });

  it("editedRepos 無しは対象外", () => {
    expect(maxReposWarn(base)).toBeNull();
  });
});

describe("repoLeaf", () => {
  it("Windows / POSIX 両方のパス末尾を小文字で返す", () => {
    expect(repoLeaf("E:\\Document\\Ars\\Lictor")).toBe("lictor");
    expect(repoLeaf("/home/x/Concordia")).toBe("concordia");
    expect(repoLeaf("/home/x/Concordia/")).toBe("concordia"); // 末尾スラッシュを無視
    expect(repoLeaf("Lictor")).toBe("lictor"); // プロジェクト名そのまま
    expect(repoLeaf(undefined)).toBe("");
  });
});

describe("teamWorktreeRestriction", () => {
  it("worktree=repo-root-only のチームは worktree 内編集を deny", () => {
    const hit = teamWorktreeRestriction({
      tool: "Edit",
      filePath: "/repo/a.ts",
      isWorktree: true,
      teamWorktreePolicy: "repo-root-only",
    });
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("team-worktree-restriction");
  });

  it("同じチームでも repo root (非 worktree) の編集は素通し", () => {
    expect(teamWorktreeRestriction({
      tool: "Edit",
      filePath: "/repo/a.ts",
      isWorktree: false,
      teamWorktreePolicy: "repo-root-only",
    })).toBeNull();
  });

  it("team 未所属 (teamWorktreePolicy 未指定) は worktree 内編集でも強制しない (フォールバック)", () => {
    expect(teamWorktreeRestriction({ tool: "Edit", filePath: "/repo/a.ts", isWorktree: true })).toBeNull();
  });

  it("worktree=allowed のチームは worktree 内編集を強制しない", () => {
    expect(teamWorktreeRestriction({
      tool: "Edit",
      filePath: "/repo/a.ts",
      isWorktree: true,
      teamWorktreePolicy: "allowed",
    })).toBeNull();
  });

  it("編集系でないツールは対象外", () => {
    expect(teamWorktreeRestriction({
      tool: "Bash",
      command: "ls",
      isWorktree: true,
      teamWorktreePolicy: "repo-root-only",
    })).toBeNull();
  });
});

describe("privateTeamPublication", () => {
  it("warns before a private team's artifact is published externally", () => {
    expect(privateTeamPublication({
      tool: "Bash",
      command: "gh release create v1.0.0",
      teamVisibility: "private",
    })).toEqual(expect.objectContaining({
      rule: "private-team-publication",
      decision: "warn",
    }));
  });

  it("does not change public or team-unset behavior", () => {
    const action = { tool: "Bash", command: "gh release create v1.0.0" };
    expect(privateTeamPublication({ ...action, teamVisibility: "public" })).toBeNull();
    expect(privateTeamPublication(action)).toBeNull();
  });
});

describe("outsideScope", () => {
  it("作業対象 (target) 外のリポ編集を warn", () => {
    const hit = outsideScope({
      tool: "Edit",
      filePath: "E:\\Document\\Ars\\Memoria\\a.ts",
      cwd: "E:\\Document\\Ars\\Memoria",
      targetProject: "Lictor",
      branch: "feat/x",
    });
    expect(hit?.decision).toBe("warn");
    expect(hit?.rule).toBe("outside-scope");
  });

  it("対象リポと一致すれば素通し (パス vs プロジェクト名を leaf 比較で吸収)", () => {
    expect(
      outsideScope({ tool: "Edit", cwd: "E:\\Document\\Ars\\Lictor", targetProject: "Lictor" }),
    ).toBeNull();
    expect(
      outsideScope({ tool: "Edit", cwd: "E:\\Document\\Ars\\Lictor", targetProject: "E:\\Document\\Ars\\Lictor" }),
    ).toBeNull();
  });

  it("targetProject 未宣言 / 現在リポ不明なら強制しない", () => {
    expect(outsideScope({ tool: "Edit", cwd: "/x/Memoria" })).toBeNull();
    expect(outsideScope({ tool: "Edit", targetProject: "Lictor" })).toBeNull();
  });

  it("編集ツール以外 (Bash 等) は対象外", () => {
    expect(
      outsideScope({ tool: "Bash", command: "ls", cwd: "/x/Memoria", targetProject: "Lictor" }),
    ).toBeNull();
  });
});
