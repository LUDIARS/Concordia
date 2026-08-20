import { describe, expect, it } from "vitest";

import { decideSessionMergeScope } from "./session-merge-scope.js";

describe("decideSessionMergeScope", () => {
  it("allows a session working on the same repository regardless of origin notation", () => {
    expect(decideSessionMergeScope({
      sessionRepoOrigin: "https://github.com/LUDIARS/Concordia.git",
      localPrRepository: "LUDIARS/Concordia",
    })).toEqual({ allowed: true, project: "LUDIARS/Concordia" });

    expect(decideSessionMergeScope({
      sessionRepoOrigin: "git@github.com:LUDIARS/Concordia.git",
      localPrRepository: "https://github.com/ludiars/concordia",
    })).toMatchObject({ allowed: true });
  });

  it("refuses a session working on a different repository", () => {
    expect(decideSessionMergeScope({
      sessionRepoOrigin: "https://github.com/LUDIARS/Concordia.git",
      localPrRepository: "LUDIARS/Memoria",
    })).toMatchObject({ allowed: false, reason: "project_mismatch" });
  });

  it("refuses when either side cannot be identified", () => {
    expect(decideSessionMergeScope({ sessionFound: false }))
      .toMatchObject({ allowed: false, reason: "session_unknown" });
    expect(decideSessionMergeScope({ sessionRepoOrigin: "  ", localPrRepository: "LUDIARS/Concordia" }))
      .toMatchObject({ allowed: false, reason: "session_repo_unknown" });
    expect(decideSessionMergeScope({ sessionRepoOrigin: "LUDIARS/Concordia", localPrRepository: null }))
      .toMatchObject({ allowed: false, reason: "local_pr_repo_unknown" });
  });

  it("keeps unresolvable local paths distinct instead of collapsing them into a match", () => {
    // 正規化できないローカルパス同士が「同じ扱い」になると、 別プロジェクトの PR が
    // 通ってしまう。 原文比較へ落ちても違うものは違うままにする。
    expect(decideSessionMergeScope({
      sessionRepoOrigin: "E:/Document/Ars/Concordia",
      localPrRepository: "E:/Document/Ars/Memoria",
    })).toMatchObject({ allowed: false, reason: "project_mismatch" });
  });
});
