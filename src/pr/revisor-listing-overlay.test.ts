import { describe, expect, it } from "vitest";
import type { RevisorLocalPr } from "./revisor-client.js";
import { overlayOpenDetails } from "./revisor-listing-overlay.js";

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

describe("overlayOpenDetails (#2263 behavior)", () => {
  it("replaces summary rows by open details and keeps the summary order", () => {
    const merged = overlayOpenDetails(
      [pr("open-1"), pr("merged-1", { status: "merged" })],
      [pr("open-1", { headRef: "feat/x" })],
    );
    expect(merged.map((row) => [row.id, row.status, row.headRef])).toEqual([
      ["open-1", "open", "feat/x"],
      ["merged-1", "merged", ""],
    ]);
  });

  it("appends open PRs missing from the summary", () => {
    expect(overlayOpenDetails([pr("a", { status: "closed" })], [pr("b")]).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("returns only open PRs when the summary could not be read", () => {
    expect(overlayOpenDetails(null, [pr("b")]).map((row) => row.id)).toEqual(["b"]);
  });
});
