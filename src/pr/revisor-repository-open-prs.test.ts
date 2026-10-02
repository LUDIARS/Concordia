import { describe, expect, it, vi } from "vitest";
import type { RevisorLocalPrSummary } from "./revisor-local-pr-client.js";
import { listRepositoryOpenPrs, selectRepositoryOpenCandidates } from "./revisor-repository-open-prs.js";

function row(overrides: Partial<RevisorLocalPrSummary>): RevisorLocalPrSummary {
  return {
    id: "lpr-1",
    number: 1,
    repository: "LUDIARS/Concordia",
    headRef: "",
    status: "open",
    checkStatus: "queued",
    ...overrides,
  };
}

describe("selectRepositoryOpenCandidates", () => {
  it("keeps only open PRs of the target repository across notations", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", repository: "LUDIARS/Revisor" }),
      row({ id: "c", status: "merged" }),
    ];
    expect(selectRepositoryOpenCandidates("https://github.com/LUDIARS/Concordia.git", rows).map((pr) => pr.id))
      .toEqual(["a"]);
  });

  it("never widens to every repository when the repository is blank", () => {
    expect(selectRepositoryOpenCandidates("  ", [row({})])).toEqual([]);
  });
});

describe("listRepositoryOpenPrs", () => {
  it("reads details only for the target repository and drops PRs settled in between", async () => {
    const getDetail = vi.fn(async (id: string) => {
      if (id === "a") return row({ id: "a", headRef: "feat/a", sessionId: "s-1" });
      if (id === "c") return row({ id: "c", headRef: "feat/c", status: "merged" });
      return null;
    });
    const result = await listRepositoryOpenPrs({
      listOpenSummaries: async () => [
        row({ id: "a" }),
        row({ id: "b", repository: "LUDIARS/Revisor" }),
        row({ id: "c" }),
        row({ id: "d" }),
      ],
      getDetail,
    }, "LUDIARS/Concordia");
    expect(result.map((pr) => [pr.id, pr.headRef])).toEqual([["a", "feat/a"]]);
    expect(getDetail.mock.calls.map(([id]) => id)).toEqual(["a", "c", "d"]);
  });
});
