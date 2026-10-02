import { describe, expect, it, vi } from "vitest";
import type { RevisorLocalPr } from "../pr/revisor-client.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { findSessionLocalPr, runGoalMachine } from "./goal-machine.js";
import { RevisorLookupUnavailable } from "./failure.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { ConfirmIntakeDeps } from "../release/confirm-intake.js";

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
  it("distinguishes unavailable evidence from a missing PR", async () => {
    await expect(findSessionLocalPr({
      sessionId: "s-1",
      sessions: sessions(),
      revisor: reader(new Error("connect ECONNREFUSED")),
    })).rejects.toBeInstanceOf(RevisorLookupUnavailable);
  });

  it("does not ask for a new PR when lookup failed", async () => {
    const events: ConcordiaEvent[] = [];
    const stop = eventBus.subscribe((event) => events.push(event));
    try {
      await expect(runGoalMachine({
        sessionId: "s-1", sessions: sessions(),
        prs: { list: vi.fn(() => []) } as unknown as PrRecordsRepo,
        confirm: {} as ConfirmIntakeDeps,
        revisor: reader(new Error("private upstream response")),
      })).rejects.toBeInstanceOf(RevisorLookupUnavailable);
      expect(events).toEqual([]);
    } finally { stop(); }
  });

  // 一覧の決着済みの行は要約で headRef が空。 reader のブランチ照合を優先して使う。
  it("prefers the reader's branch lookup so a merged PR is not mistaken for a missing one", async () => {
    const findLocalPrByBranch = vi.fn(async () => localPr({ status: "merged" }));
    const found = await findSessionLocalPr({
      sessionId: "s-1",
      sessions: sessions(),
      revisor: { ...reader([localPr({ status: "merged", headRef: "" })]), findLocalPrByBranch },
    });
    expect(found?.status).toBe("merged");
    expect(findLocalPrByBranch).toHaveBeenCalledWith("https://github.com/LUDIARS/Concordia.git", "feat/thing");
  });

  it("treats a failed branch lookup as unavailable evidence", async () => {
    await expect(findSessionLocalPr({
      sessionId: "s-1",
      sessions: sessions(),
      revisor: { ...reader([]), findLocalPrByBranch: async () => { throw new Error("timed out"); } },
    })).rejects.toBeInstanceOf(RevisorLookupUnavailable);
  });
});
