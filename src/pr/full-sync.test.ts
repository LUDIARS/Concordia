import { describe, it, expect } from "vitest";
import { parseSearchPrs } from "./full-sync.js";

describe("parseSearchPrs", () => {
  it("parses gh search prs json into SearchedPr[]", () => {
    const stdout = JSON.stringify([
      { number: 12, title: "feat: x", url: "https://github.com/LUDIARS/Concordia/pull/12", isDraft: false, repository: { name: "Concordia", nameWithOwner: "LUDIARS/Concordia" } },
      { number: 3, title: "draft", url: "u", isDraft: true, repository: { nameWithOwner: "LUDIARS/Memoria" } },
    ]);
    const out = parseSearchPrs(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ repo_origin: "LUDIARS/Concordia", number: 12, isDraft: false });
    expect(out[1]).toMatchObject({ repo_origin: "LUDIARS/Memoria", number: 3, isDraft: true });
  });

  it("drops rows without owner/repo or number", () => {
    const stdout = JSON.stringify([
      { number: 1, repository: { nameWithOwner: "not-owner-repo" } }, // isOwnerRepo false
      { repository: { nameWithOwner: "LUDIARS/X" } }, // no number
      { number: 5, repository: { nameWithOwner: "LUDIARS/Valid" } },
    ]);
    const out = parseSearchPrs(stdout);
    expect(out).toHaveLength(1);
    expect(out[0].repo_origin).toBe("LUDIARS/Valid");
  });

  it("returns [] on malformed json", () => {
    expect(parseSearchPrs("not json")).toEqual([]);
    expect(parseSearchPrs("{}")).toEqual([]);
  });
});
