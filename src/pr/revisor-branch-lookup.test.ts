import { describe, expect, it, vi } from "vitest";
import type { RevisorLocalPr } from "./revisor-client.js";
import {
  findLocalPrByBranch,
  matchLocalPrByBranch,
  selectSettledCandidates,
  SETTLED_LOOKUP_LIMIT,
} from "./revisor-branch-lookup.js";

function pr(id: string, overrides: Partial<RevisorLocalPr> = {}): RevisorLocalPr {
  return {
    id,
    number: 1,
    repository: "LUDIARS/Concordia",
    title: "",
    author: "",
    status: "open",
    checkStatus: "queued",
    headRef: "",
    baseRef: "",
    headSha: "",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("matchLocalPrByBranch", () => {
  it("matches normalized repository and case-sensitive head ref", () => {
    const rows = [pr("a", { headRef: "feat/x" })];
    expect(matchLocalPrByBranch(rows, "https://github.com/ludiars/concordia.git", "feat/x")?.id).toBe("a");
    expect(matchLocalPrByBranch(rows, "LUDIARS/Concordia", "FEAT/X")).toBeNull();
    expect(matchLocalPrByBranch(rows, "LUDIARS/Revisor", "feat/x")).toBeNull();
  });

  it("never matches summary rows whose head ref is empty", () => {
    expect(matchLocalPrByBranch([pr("a")], "LUDIARS/Concordia", "")).toBeNull();
  });
});

describe("selectSettledCandidates", () => {
  it("picks the newest settled PRs of the repository up to the limit", () => {
    const rows = [
      pr("open", { updatedAt: "2026-10-02T09:00:00Z" }),
      pr("other", { status: "merged", repository: "LUDIARS/Revisor", updatedAt: "2026-10-02T09:00:00Z" }),
      ...Array.from({ length: SETTLED_LOOKUP_LIMIT + 2 }, (_, i) =>
        pr(`m${i}`, { status: "merged", updatedAt: `2026-10-01T${String(i).padStart(2, "0")}:00:00Z` })),
    ];
    const ids = selectSettledCandidates(rows, "LUDIARS/Concordia").map((row) => row.id);
    expect(ids).toHaveLength(SETTLED_LOOKUP_LIMIT);
    expect(ids[0]).toBe(`m${SETTLED_LOOKUP_LIMIT + 1}`);
    expect(ids).not.toContain("open");
    expect(ids).not.toContain("other");
  });
});

describe("findLocalPrByBranch", () => {
  it("returns an open match without reading settled PRs", async () => {
    const listLocalPrSummaries = vi.fn(async () => []);
    const found = await findLocalPrByBranch({
      listOpenLocalPrs: async () => [pr("a", { headRef: "feat/x" })],
      listLocalPrSummaries,
      getLocalPrDetail: async () => null,
    }, "LUDIARS/Concordia", "feat/x");
    expect(found?.id).toBe("a");
    expect(listLocalPrSummaries).not.toHaveBeenCalled();
  });

  // #2263 以降、決着済みの行は要約で headRef が空。単一取得で照合しないとマージ済みを見失う。
  it("finds a merged PR through the single-PR detail", async () => {
    const getLocalPrDetail = vi.fn(async (id: string) =>
      id === "m1" ? pr("m1", { status: "merged", headRef: "feat/x" }) : pr(id, { status: "merged", headRef: "feat/y" }));
    const found = await findLocalPrByBranch({
      listOpenLocalPrs: async () => [],
      listLocalPrSummaries: async () => [
        pr("m2", { status: "merged", updatedAt: "2026-10-02T02:00:00Z" }),
        pr("m1", { status: "merged", updatedAt: "2026-10-02T01:00:00Z" }),
      ],
      getLocalPrDetail,
    }, "LUDIARS/Concordia", "feat/x");
    expect(found).toMatchObject({ id: "m1", status: "merged" });
    expect(getLocalPrDetail.mock.calls.map(([id]) => id)).toEqual(["m2", "m1"]);
  });

  it("propagates lookup failures instead of answering no PR", async () => {
    await expect(findLocalPrByBranch({
      listOpenLocalPrs: async () => { throw new Error("timed out"); },
      listLocalPrSummaries: async () => [],
      getLocalPrDetail: async () => null,
    }, "LUDIARS/Concordia", "feat/x")).rejects.toThrow("timed out");
  });
});
