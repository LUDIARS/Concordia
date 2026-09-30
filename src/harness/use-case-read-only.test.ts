import { describe, expect, it } from "vitest";
import { gitWriteSubcommand, useCaseReadOnly } from "./use-case-read-only.js";

describe("useCaseReadOnly (CC-DLG-INV-03)", () => {
  it("does nothing for sessions outside a read-only use case", () => {
    expect(useCaseReadOnly({ tool: "Edit" })).toBeNull();
    expect(useCaseReadOnly({ tool: "Edit", useCaseReadOnly: false })).toBeNull();
  });

  it("denies file edits", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(useCaseReadOnly({ tool, useCaseReadOnly: true })).toMatchObject({ rule: "use-case-read-only", decision: "deny" });
    }
  });

  it("allows reading and answering", () => {
    expect(useCaseReadOnly({ tool: "Read", useCaseReadOnly: true })).toBeNull();
    expect(useCaseReadOnly({ tool: "Bash", command: "git log --oneline -5", useCaseReadOnly: true })).toBeNull();
    expect(useCaseReadOnly({ tool: "Bash", command: "grep -rn DDD spec", useCaseReadOnly: true })).toBeNull();
  });

  it("denies git writes, including inside command chains", () => {
    expect(useCaseReadOnly({ tool: "Bash", command: "git status && git commit -m x", useCaseReadOnly: true }))
      .toMatchObject({ reason: expect.stringContaining("git commit") });
    expect(useCaseReadOnly({ tool: "Bash", command: "git -C E:/repo push origin main", useCaseReadOnly: true }))
      .toMatchObject({ decision: "deny" });
  });
});

describe("gitWriteSubcommand", () => {
  it("distinguishes listing from writing for branch, tag, stash and worktree", () => {
    expect(gitWriteSubcommand("git branch")).toBeNull();
    expect(gitWriteSubcommand("git branch -a")).toBeNull();
    expect(gitWriteSubcommand("git branch -D old")).toBe("branch");
    expect(gitWriteSubcommand("git tag")).toBeNull();
    expect(gitWriteSubcommand("git tag v1.0")).toBe("tag");
    expect(gitWriteSubcommand("git stash list")).toBeNull();
    expect(gitWriteSubcommand("git stash")).toBe("stash");
    expect(gitWriteSubcommand("git worktree list")).toBeNull();
  });

  it("skips global options and ignores non-git commands", () => {
    expect(gitWriteSubcommand("git -c core.pager=cat reset --hard")).toBe("reset");
    expect(gitWriteSubcommand("/usr/bin/git add .")).toBe("add");
    expect(gitWriteSubcommand("npm test")).toBeNull();
    expect(gitWriteSubcommand("git diff | head")).toBeNull();
  });
});
