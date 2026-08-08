import { describe, expect, it } from "vitest";
import type { RevisorLocalPr } from "../pr/revisor-client.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { findSessionLocalPr } from "./goal-machine.js";

function localPr(overrides: Partial<RevisorLocalPr> = {}): RevisorLocalPr {
  return {
    id: "lpr-1",
    number: 7,
    repository: "LUDIARS/Concordia",
    title: "feat: thing",
    author: "concordia",
    status: "open",
    checkStatus: "test_ok",
    headRef: "feat/thing",
    baseRef: "main",
    headSha: "abc",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function sessions(overrides: { repo_origin?: string | null; branch?: string | null } = {}): SessionsRepo {
  return {
    findSession: () => ({
      id: "s-1",
      repo_origin: overrides.repo_origin === undefined ? "https://github.com/LUDIARS/Concordia.git" : overrides.repo_origin,
      branch: overrides.branch === undefined ? "feat/thing" : overrides.branch,
    }),
  } as unknown as SessionsRepo;
}

function reader(prs: RevisorLocalPr[] | Error) {
  return {
    listLocalPrs: async () => {
      if (prs instanceof Error) throw prs;
      return prs;
    },
    baseUrl: async () => "http://127.0.0.1:4240",
  };
}

describe("findSessionLocalPr", () => {
  // sessions.repo_origin は remote URL の生値で来る。 owner/repo 正規化を通さないと
  // どのセッションの local PR も見つからず、 接続断 (この機能が潰す障害) が再発する。
  it("matches the session branch against a local PR across repository notations", async () => {
    const found = await findSessionLocalPr({
      sessionId: "s-1",
      sessions: sessions(),
      revisor: reader([localPr()]),
    });
    expect(found?.id).toBe("lpr-1");
  });

  it("keeps head refs case-sensitive like git", async () => {
    const found = await findSessionLocalPr({
      sessionId: "s-1",
      sessions: sessions({ branch: "FEAT/THING" }),
      revisor: reader([localPr()]),
    });
    expect(found).toBeNull();
  });

  it("returns null when the session has no branch or origin", async () => {
    expect(await findSessionLocalPr({ sessionId: "s-1", sessions: sessions({ branch: null }), revisor: reader([localPr()]) })).toBeNull();
    expect(await findSessionLocalPr({ sessionId: "s-1", sessions: sessions({ repo_origin: null }), revisor: reader([localPr()]) })).toBeNull();
  });

  // Revisor 停止中に「PR 無し」へ誤判定すると pr-decision メンションが誤発火する。
  it("returns null instead of failing when Revisor is unreachable", async () => {
    const found = await findSessionLocalPr({
      sessionId: "s-1",
      sessions: sessions(),
      revisor: reader(new Error("connect ECONNREFUSED")),
    });
    expect(found).toBeNull();
  });
});
