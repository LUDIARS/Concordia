import { describe, expect, it, vi } from "vitest";
import { composeGithubPr, readGithubPrContent } from "./github-pr-content.js";

describe("composeGithubPr", () => {
  it("titles the PR with the first commit and lists every commit oldest first", () => {
    expect(composeGithubPr(["fix: follow-up", "feat: add x", ""])).toEqual({
      title: "feat: add x",
      body: "## Commits\n- feat: add x\n- fix: follow-up\n\nSubmitted through Concordia (`POST /v1/implementation-tools/submit`).",
    });
  });

  it("hides local paths from the public text", () => {
    expect(composeGithubPr(["fix: read E:\\Document\\Ars\\Game\\a.ts"])?.title).not.toContain("E:\\Document");
  });

  it("returns null when the branch has no commits ahead of the base", () => {
    expect(composeGithubPr(["", "  "])).toBeNull();
  });
});

describe("readGithubPrContent", () => {
  it("reads only base..HEAD subjects", async () => {
    const read = vi.fn(async () => "feat: add x\n");
    expect(await readGithubPrContent("E:/Work/Game", "main", read)).toMatchObject({ title: "feat: add x" });
    expect(read).toHaveBeenCalledWith("E:/Work/Game", ["log", "--format=%s", "main..HEAD"]);
  });
});
