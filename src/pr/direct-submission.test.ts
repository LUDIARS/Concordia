import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import { submitDirectLocalPr, type DirectLocalPrDeps } from "./direct-submission.js";
import type { RevisorLocalPrGateway } from "./revisor-local-pr-client.js";

const REGISTRATIONS = [
  { repository: "LUDIARS/Concordia", rootPath: "E:/Document/Ars/Concordia", baseRef: "main" },
];

// isWithinWorkspace は realpath を取るので、 実在するパス (このリポの cwd) を使う。
const REPO = process.cwd();

function gateway(overrides: Partial<RevisorLocalPrGateway> = {}): RevisorLocalPrGateway {
  return {
    listRepositories: async () => REGISTRATIONS,
    listLocalPullRequests: async () => [],
    submitLocalPullRequest: async (input) => ({
      id: "pr-9",
      number: 9,
      repository: input.repository,
      headRef: input.headRef,
      status: "open",
      checkStatus: "queued",
    }),
    retryLocalPullRequest: async (id) => ({
      id,
      number: 9,
      repository: "LUDIARS/Concordia",
      headRef: "feat/thing",
      status: "open",
      checkStatus: "queued",
    }),
    ...overrides,
  };
}

/** git 呼び出しの決定的なスタブ。 実リポには触らない。 */
function fakeGit(options: { currentBranch?: string; branchExists?: boolean } = {}) {
  return async (_cwd: string, args: readonly string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined === "rev-parse --show-toplevel") return REPO;
    if (joined === "remote get-url origin") return "https://github.com/LUDIARS/Concordia.git";
    if (joined === "branch --show-current") return options.currentBranch ?? "feat/thing";
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (options.branchExists === false) throw new Error("unknown revision");
      return "abc123";
    }
    throw new Error(`unexpected git args: ${joined}`);
  };
}

function deps(overrides: Partial<DirectLocalPrDeps> = {}): DirectLocalPrDeps {
  return {
    revisor: gateway(),
    listBranchCommits: async () => ["feat: direct 提出"],
    resolveWorkspaceRoots: () => [REPO],
    runGit: fakeGit(),
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  };
}

describe("submitDirectLocalPr", () => {
  it("submits a named branch without any session binding", async () => {
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    const result = await submitDirectLocalPr(
      deps({ revisor: gateway({ submitLocalPullRequest }) }),
      { repoPath: REPO, branch: "feat/thing" },
    );

    expect(result).toEqual({ submitted: true, pullRequest: expect.objectContaining({ id: "pr-9" }) });
    const input = submitLocalPullRequest.mock.calls[0][0];
    expect(input).toMatchObject({ repository: "LUDIARS/Concordia", headRef: "feat/thing", baseRef: "main" });
    // session 無し = binding 無し。 sessionId を undefined ですら送らない。
    expect("sessionId" in input).toBe(false);
    expect(input.body).toContain("direct");
  });

  it("keeps the session binding when a session id is supplied", async () => {
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    await submitDirectLocalPr(
      deps({ revisor: gateway({ submitLocalPullRequest }) }),
      { repoPath: REPO, branch: "feat/thing", sessionId: "s-1" },
    );
    expect(submitLocalPullRequest).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" }));
  });

  it("passes the supplied PR content through to the submission", async () => {
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    const authored = "## 実装内容\n\n直指定で本文を渡す。\n\n## 受け入れ条件\n\n本文がそのまま届く。";

    await submitDirectLocalPr(
      deps({ revisor: gateway({ submitLocalPullRequest }) }),
      { repoPath: REPO, branch: "feat/thing", prContent: authored },
    );

    expect(submitLocalPullRequest).toHaveBeenCalledWith(expect.objectContaining({ body: authored }));
  });

  it("falls back to the checkout branch when branch is omitted", async () => {
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    await submitDirectLocalPr(
      deps({ revisor: gateway({ submitLocalPullRequest }), runGit: fakeGit({ currentBranch: "feat/current" }) }),
      { repoPath: REPO },
    );
    expect(submitLocalPullRequest).toHaveBeenCalledWith(expect.objectContaining({ headRef: "feat/current" }));
  });

  it("rejects a relative repo_path", async () => {
    const result = await submitDirectLocalPr(deps(), { repoPath: "Concordia" });
    expect(result).toEqual({ submitted: false, reason: "error", detail: "repo_path must be an absolute path" });
  });

  it("rejects a repo_path outside the workspace roots", async () => {
    const result = await submitDirectLocalPr(deps(), { repoPath: tmpdir() });
    expect(result).toMatchObject({ submitted: false, reason: "error" });
    expect((result as { detail?: string }).detail).toContain("workspace roots");
  });

  it("rejects a branch that does not exist instead of reporting no_commits", async () => {
    const result = await submitDirectLocalPr(
      deps({ runGit: fakeGit({ branchExists: false }) }),
      { repoPath: REPO, branch: "feat/missing" },
    );
    expect(result).toMatchObject({ submitted: false, reason: "error" });
    expect((result as { detail?: string }).detail).toContain("does not exist");
  });

  it("rejects a branch name git would parse as an option or revision syntax", async () => {
    for (const branch of ["--output=x", "a b", "a~1"]) {
      const result = await submitDirectLocalPr(deps(), { repoPath: REPO, branch });
      expect(result).toMatchObject({ submitted: false, reason: "error", detail: "branch contains unsafe characters" });
    }
  });

  it("reports a detached checkout as no_branch through the shared plan", async () => {
    const result = await submitDirectLocalPr(
      deps({ runGit: fakeGit({ currentBranch: "" }) }),
      { repoPath: REPO },
    );
    expect(result).toEqual({ submitted: false, reason: "no_branch" });
  });
});
