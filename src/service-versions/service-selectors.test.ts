import { describe, expect, it } from "vitest";
import {
  expandSelectors,
  resolveCurrentProject,
  UnknownProjectError,
  type ProjectCodeLookup,
} from "./service-selectors.js";

const ROWS = [
  {
    code: "Rv",
    project: "Revisor",
    repo_path: "E:/Document/Ars/Revisor",
    repo_origin: "https://github.com/LUDIARS/Revisor.git",
  },
  {
    code: "Cc",
    project: "Concordia",
    repo_path: "E:\\Document\\Ars\\Concordia",
    repo_origin: "LUDIARS/Concordia",
  },
];

function lookup(): ProjectCodeLookup {
  return {
    list: () => ROWS,
    findByCode: (code) => ROWS.find((row) => row.code === code) ?? null,
    findByRepoOrigin: (origin) => {
      const target = origin.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").toLowerCase();
      return ROWS.find((row) =>
        (row.repo_origin ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")
          .toLowerCase() === target) ?? null;
    },
  };
}

describe("expandSelectors", () => {
  it("LUDIARS のプロジェクトコードを実名へ開く", () => {
    expect(expandSelectors(lookup(), ["Rv", "Cc"])).toEqual(["Revisor", "Concordia"]);
  });

  // catalog の service code は Cc の registry に無い。 知らない名前は触らずに渡し、
  // 解決は catalog を持つ Revisor に任せる。
  it("registry に無い名前はそのまま通す", () => {
    expect(expandSelectors(lookup(), ["concordia-cost"])).toEqual(["concordia-cost"]);
  });

  it("カンマ区切りを展開し重複を畳む", () => {
    expect(expandSelectors(lookup(), ["Rv,Cc", "Revisor", " "])).toEqual(["Revisor", "Concordia"]);
  });

  // 略称は大文字小文字を区別する (CLAUDE.md の通し表と同じ規約)。
  it("略称の大文字小文字を畳まない", () => {
    expect(expandSelectors(lookup(), ["rv"])).toEqual(["rv"]);
  });
});

describe("resolveCurrentProject", () => {
  it("origin で登録プロジェクトを引く", () => {
    expect(resolveCurrentProject(lookup(), {
      repoPath: "E:/Document/Ars/Revisor",
      repoOrigin: "LUDIARS/Revisor",
    })).toBe("Revisor");
  });

  // 実装は task 専用 worktree で行う。 パス前方一致だけだと本体 checkout に居るときしか
  // 一致せず、 実際に作業している場所で答えられない。
  it("worktree から呼ばれても origin で本体に寄せる", () => {
    expect(resolveCurrentProject(lookup(), {
      repoPath: "E:/Document/Ars/.worktrees/Revisor-service-version",
      repoOrigin: "https://github.com/LUDIARS/Revisor.git",
    })).toBe("Revisor");
  });

  it("origin が無ければ登録パスで引く", () => {
    expect(resolveCurrentProject(lookup(), {
      repoPath: "E:/Document/Ars/Concordia",
      repoOrigin: null,
    })).toBe("Concordia");
  });

  it("未登録なら推測せず明示指定を促す", () => {
    expect(() => resolveCurrentProject(lookup(), {
      repoPath: "E:/Document/Ars/Unknown",
      repoOrigin: null,
    })).toThrow(UnknownProjectError);
  });
});
