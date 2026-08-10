import { describe, expect, it, vi } from "vitest";

import { planLocalPrSubmission, submitSessionLocalPr } from "./local-pr-submission.js";
import type { RevisorLocalPrGateway } from "./revisor-local-pr-client.js";

const REGISTRATIONS = [
  { repository: "LUDIARS/Concordia", rootPath: "E:/Document/Ars/Concordia", baseRef: "main" },
];

function plan(overrides: Partial<Parameters<typeof planLocalPrSubmission>[0]> = {}) {
  return planLocalPrSubmission({
    repository: "LUDIARS/Concordia",
    branch: "feat/thing",
    registrations: REGISTRATIONS,
    openPullRequests: [],
    hasCommits: true,
    ...overrides,
  });
}

describe("planLocalPrSubmission", () => {
  it("submits a branch that has commits in a registered repository", () => {
    expect(plan()).toEqual({
      submit: true,
      repository: "LUDIARS/Concordia",
      headRef: "feat/thing",
      baseRef: "main",
    });
  });

  it("names a reason instead of skipping silently", () => {
    expect(plan({ branch: null })).toEqual({ submit: false, reason: "no_branch" });
    expect(plan({ branch: "main" })).toEqual({ submit: false, reason: "on_base_branch" });
    expect(plan({ hasCommits: false })).toEqual({ submit: false, reason: "no_commits" });
    expect(plan({ repository: "LUDIARS/Unregistered" }))
      .toEqual({ submit: false, reason: "repository_not_registered" });
    expect(plan({ repository: null }))
      .toEqual({ submit: false, reason: "repository_not_registered" });
  });

  it("does not submit the same branch twice while a local PR is open", () => {
    const openPullRequests = [{
      id: "pr-1",
      number: 1,
      repository: "LUDIARS/Concordia",
      headRef: "feat/thing",
      status: "open",
      checkStatus: "queued",
    }];
    expect(plan({ openPullRequests })).toEqual({ submit: false, reason: "already_open" });
    // マージ済みの同名ブランチは再提出を妨げない。
    expect(plan({ openPullRequests: [{ ...openPullRequests[0], status: "merged" }] }).submit).toBe(true);
  });

  it("promotes a queued duplicate only for its submitting session after explicit fast-lane opt-in", () => {
    const openPullRequests = [{
      id: "pr-1",
      number: 1,
      repository: "LUDIARS/Concordia",
      headRef: "feat/thing",
      status: "open",
      checkStatus: "queued",
      sessionId: "s-1",
    }];
    expect(plan({ openPullRequests, fastLane: false }))
      .toEqual({ submit: false, reason: "already_open" });
    expect(plan({ openPullRequests, sessionId: "s-1", fastLane: true }))
      .toEqual({ submit: false, promote: true, pullRequestId: "pr-1" });
    expect(plan({ openPullRequests, sessionId: "s-2", fastLane: true }))
      .toEqual({ submit: false, reason: "already_open" });
  });

  it("retries a failed open local PR instead of creating a duplicate", () => {
    expect(plan({ openPullRequests: [{
      id: "pr-1",
      number: 1,
      repository: "LUDIARS/Concordia",
      headRef: "feat/thing",
      status: "open",
      checkStatus: "failed",
    }] })).toEqual({ submit: false, retry: true, pullRequestId: "pr-1" });
  });

  it("matches the repository and base ref case-insensitively", () => {
    expect(plan({ repository: "ludiars/concordia" }).submit).toBe(true);
    expect(plan({ branch: "MAIN" })).toEqual({ submit: false, reason: "on_base_branch" });
  });

  // sessions.repo_origin は `git config --get remote.origin.url` の生値。 owner/repo に
  // 正規化せず比較すると全セッションが未登録扱いになり、 レビューが 1 件も発火しない。
  it("matches a session repo_origin that is a remote URL against an owner/repo registration", () => {
    expect(plan({ repository: "https://github.com/LUDIARS/Concordia.git" }).submit).toBe(true);
    expect(plan({ repository: "https://github.com/LUDIARS/Concordia" }).submit).toBe(true);
    expect(plan({ repository: "git@github.com:LUDIARS/Concordia.git" }).submit).toBe(true);
    // 別リポの URL は取り違えない。
    expect(plan({ repository: "git@github.com:LUDIARS/Memoria.git" }))
      .toEqual({ submit: false, reason: "repository_not_registered" });
  });

  it("detects an already-open PR regardless of the repository notation", () => {
    const openPullRequests = [{
      id: "pr-1",
      number: 1,
      repository: "https://github.com/LUDIARS/Concordia.git",
      headRef: "feat/thing",
      status: "open",
      checkStatus: "queued",
    }];
    expect(plan({ openPullRequests })).toEqual({ submit: false, reason: "already_open" });
  });
});

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
    promoteLocalPullRequest: async (id) => ({
      id,
      number: 9,
      repository: "LUDIARS/Concordia",
      headRef: "feat/thing",
      status: "open",
      checkStatus: "queued",
      reviewLane: "fast",
    }),
    ...overrides,
  };
}

const log = { info: () => {}, warn: () => {} };

describe("submitSessionLocalPr", () => {
  const request = {
    sessionId: "s-1",
    repoPath: "E:/Document/Ars/Concordia",
    repository: "LUDIARS/Concordia",
    branch: "feat/thing",
  };

  it("submits with the newest commit subject as the title", async () => {
    let sent: { title: string; body: string } | null = null;
    const submitLocalPullRequest = vi.fn(async (input: { title: string; body: string }) => {
      sent = { title: input.title, body: input.body };
      return {
        id: "pr-9",
        number: 9,
        repository: "LUDIARS/Concordia",
        headRef: "feat/thing",
        status: "open",
        checkStatus: "queued",
      };
    });
    const result = await submitSessionLocalPr({
      revisor: gateway({ submitLocalPullRequest }),
      listBranchCommits: async () => ["feat: 後の変更", "feat: 最初の変更"],
      log,
    }, request);

    expect(result).toEqual({ submitted: true, pullRequest: expect.objectContaining({ id: "pr-9" }) });
    expect(submitLocalPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      repository: "LUDIARS/Concordia",
      headRef: "feat/thing",
      baseRef: "main",
      sessionId: "s-1",
      title: "feat: 後の変更",
      author: "concordia",
    }));
    expect(submitLocalPullRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ fastLane: true }),
    );
    expect(sent!.body).toContain("s-1");
    expect(sent!.body).toContain("feat: 最初の変更");
  });

  it("carries an explicit per-session fast-lane opt-in", async () => {
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    await submitSessionLocalPr({
      revisor: gateway({ submitLocalPullRequest }),
      listBranchCommits: async () => ["feat: 早期確認"],
      log,
    }, { ...request, fastLane: true });
    expect(submitLocalPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fastLane: true, sessionId: "s-1" }),
    );
  });

  it("moves the owning session's queued duplicate to the fast lane", async () => {
    const promoteLocalPullRequest = vi.fn(gateway().promoteLocalPullRequest);
    const result = await submitSessionLocalPr({
      revisor: gateway({
        listLocalPullRequests: async () => [{
          id: "pr-9",
          number: 9,
          repository: "LUDIARS/Concordia",
          headRef: "feat/thing",
          status: "open",
          checkStatus: "queued",
          sessionId: "s-1",
        }],
        promoteLocalPullRequest,
      }),
      listBranchCommits: async () => ["feat: 早期確認"],
      log,
    }, { ...request, fastLane: true });
    expect(promoteLocalPullRequest).toHaveBeenCalledWith("pr-9", "s-1");
    expect(result).toEqual({
      submitted: false,
      resubmitted: true,
      pullRequest: expect.objectContaining({ id: "pr-9", reviewLane: "fast" }),
    });
  });

  it("does not promote another session's queued duplicate", async () => {
    const promoteLocalPullRequest = vi.fn(gateway().promoteLocalPullRequest);
    const result = await submitSessionLocalPr({
      revisor: gateway({
        listLocalPullRequests: async () => [{
          id: "pr-9",
          number: 9,
          repository: "LUDIARS/Concordia",
          headRef: "feat/thing",
          status: "open",
          checkStatus: "queued",
          sessionId: "s-other",
        }],
        promoteLocalPullRequest,
      }),
      listBranchCommits: async () => ["feat: 早期確認"],
      log,
    }, { ...request, fastLane: true });

    expect(result).toEqual({ submitted: false, reason: "already_open" });
    expect(promoteLocalPullRequest).not.toHaveBeenCalled();
  });

  it("uses the author's PR content verbatim instead of generating a body", async () => {
    let sent: { title: string; body: string } | null = null;
    const submitLocalPullRequest = vi.fn(async (input: { title: string; body: string }) => {
      sent = { title: input.title, body: input.body };
      return {
        id: "pr-10",
        number: 10,
        repository: "LUDIARS/Concordia",
        headRef: "feat/thing",
        status: "open",
        checkStatus: "queued",
      };
    });
    const authored = "## 実装内容\n\n本文を渡せるようにした。\n\n## 受け入れ条件\n\n本文がそのまま届く。";

    await submitSessionLocalPr({
      revisor: gateway({ submitLocalPullRequest }),
      listBranchCommits: async () => ["feat: 本文を渡す"],
      log,
    }, { ...request, prContent: authored });

    expect(sent!.body).toBe(authored);
    // 由来の説明行や「コミット:」の並びが混ざると、書き手が組んだ見出し構造が崩れる。
    expect(sent!.body).not.toContain("Concordia session");
    expect(sent!.body).not.toContain("コミット:");
    // タイトルは従来どおり最新コミット件名。
    expect(sent!.title).toBe("feat: 本文を渡す");
  });

  it("falls back to the generated body when the supplied content is blank", async () => {
    let sent: { body: string } | null = null;
    const submitLocalPullRequest = vi.fn(async (input: { title: string; body: string }) => {
      sent = { body: input.body };
      return {
        id: "pr-11",
        number: 11,
        repository: "LUDIARS/Concordia",
        headRef: "feat/thing",
        status: "open",
        checkStatus: "queued",
      };
    });

    await submitSessionLocalPr({
      revisor: gateway({ submitLocalPullRequest }),
      listBranchCommits: async () => ["feat: x"],
      log,
    }, { ...request, prContent: "   \n  " });

    expect(sent!.body).toContain("Concordia session");
  });

  // Revisor の PR 内容契約 (`local-contracts.mjs` の `prContent`) を満たさない本文は
  // 400 で拒否され、Cc 経由の提出が全セッションで止まる (2026-08-10 に発生)。
  // 節の有無だけでなく「非空かつ日本語を含む」ところまで見る — 契約の判定条件がそれ。
  it("emits title and body that satisfy the Revisor PR content contract", async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const submitLocalPullRequest = vi.fn(async (input: { title: string; body: string }) => {
      sent.push({ title: input.title, body: input.body });
      return {
        id: "pr-9",
        number: 9,
        repository: "LUDIARS/Concordia",
        headRef: "feat/thing",
        status: "open" as const,
        checkStatus: "queued" as const,
      };
    });
    // 件名が英語だけでも日本語判定を満たすこと (箇条書きだけに頼らない)。
    await submitSessionLocalPr({
      revisor: gateway({ submitLocalPullRequest }),
      listBranchCommits: async () => ["fix(log): drop a repeated line"],
      log,
    }, request);

    const japanese = /[぀-ヿ㐀-鿿]/;
    expect(japanese.test(sent[0]!.title), "title must contain Japanese").toBe(true);
    expect(sent[0]!.title).toBe("変更: fix(log): drop a repeated line");
    for (const heading of ["実装内容", "受け入れ条件"]) {
      const section = sent[0]!.body.split(new RegExp(`^##\\s+${heading}\\s*$`, "m"))[1] ?? "";
      const content = section.split(/^##\s+/m)[0]!.trim();
      expect(content, `## ${heading} must not be empty`).not.toBe("");
      expect(japanese.test(content), `## ${heading} must contain Japanese`).toBe(true);
    }
  });

  it("submits even when optional source-link resolution fails", async () => {
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    const warn = vi.fn();

    const result = await submitSessionLocalPr({
      revisor: gateway({ submitLocalPullRequest }),
      listBranchCommits: async () => ["feat: x"],
      resolveSourceLinks: async () => { throw new Error("Slack unavailable"); },
      log: { info: vi.fn(), warn },
    }, request);

    expect(result.submitted).toBe(true);
    expect(submitLocalPullRequest).toHaveBeenCalledWith(expect.objectContaining({ sourceLinks: [] }));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "s-1", err: "Slack unavailable" }),
      "local PR source-link resolution failed",
    );
  });

  // 実際の session.repo_origin はこの形で来る。 ここが素通しだと自動提出は永久に
  // repository_not_registered で止まる。
  it("resolves the base ref for a session whose repo_origin is a remote URL", async () => {
    const listBranchCommits = vi.fn(async () => ["feat: x"]);
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    const result = await submitSessionLocalPr({
      revisor: gateway({ submitLocalPullRequest }),
      listBranchCommits,
      log,
    }, { ...request, repository: "git@github.com:LUDIARS/Concordia.git" });

    expect(result.submitted).toBe(true);
    expect(listBranchCommits).toHaveBeenCalledWith("E:/Document/Ars/Concordia", "main", "feat/thing");
    expect(submitLocalPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      repository: "LUDIARS/Concordia",
      baseRef: "main",
      headRef: "feat/thing",
      sessionId: "s-1",
    }));
  });

  it("does not call git when the repository is not registered", async () => {
    const listBranchCommits = vi.fn(async () => ["x"]);
    const result = await submitSessionLocalPr({
      revisor: gateway(),
      listBranchCommits,
      log,
    }, { ...request, repository: "LUDIARS/Unregistered" });

    expect(result).toEqual({ submitted: false, reason: "repository_not_registered" });
    expect(listBranchCommits).not.toHaveBeenCalled();
  });

  it("skips a branch with no commits ahead of the base", async () => {
    const result = await submitSessionLocalPr({
      revisor: gateway(),
      listBranchCommits: async () => [],
      log,
    }, request);
    expect(result).toEqual({ submitted: false, reason: "no_commits" });
  });

  it("retries a failed local PR without submitting a second one", async () => {
    const retryLocalPullRequest = vi.fn(gateway().retryLocalPullRequest);
    const submitLocalPullRequest = vi.fn(gateway().submitLocalPullRequest);
    const result = await submitSessionLocalPr({
      revisor: gateway({
        listLocalPullRequests: async () => [{
          id: "pr-9",
          number: 9,
          repository: "LUDIARS/Concordia",
          headRef: "feat/thing",
          status: "open",
          checkStatus: "action_required",
        }],
        retryLocalPullRequest,
        submitLocalPullRequest,
      }),
      listBranchCommits: async () => ["feat: x"],
      log,
    }, request);

    expect(result).toEqual({ submitted: false, resubmitted: true, pullRequest: expect.objectContaining({ id: "pr-9" }) });
    expect(retryLocalPullRequest).toHaveBeenCalledWith("pr-9");
    expect(submitLocalPullRequest).not.toHaveBeenCalled();
  });

  it("does not promote a retried PR unless it belongs to the requesting session", async () => {
    const promoteLocalPullRequest = vi.fn(gateway().promoteLocalPullRequest);
    const result = await submitSessionLocalPr({
      revisor: gateway({
        listLocalPullRequests: async () => [{
          id: "pr-9",
          number: 9,
          repository: "LUDIARS/Concordia",
          headRef: "feat/thing",
          status: "open",
          checkStatus: "failed",
          sessionId: "s-other",
        }],
        retryLocalPullRequest: async () => ({
          id: "pr-9",
          number: 9,
          repository: "LUDIARS/Concordia",
          headRef: "feat/thing",
          status: "open",
          checkStatus: "queued",
          sessionId: "s-other",
        }),
        promoteLocalPullRequest,
      }),
      listBranchCommits: async () => ["feat: x"],
      log,
    }, { ...request, fastLane: true });

    expect(result).toEqual({ submitted: false, resubmitted: true, pullRequest: expect.objectContaining({ id: "pr-9" }) });
    expect(promoteLocalPullRequest).not.toHaveBeenCalled();
  });

  // セッション終了処理をレビュー発火の失敗で壊さない。
  it("reports a failure instead of throwing", async () => {
    const result = await submitSessionLocalPr({
      revisor: gateway({
        submitLocalPullRequest: async () => { throw new Error("worktree is no longer clean"); },
      }),
      listBranchCommits: async () => ["feat: x"],
      log,
    }, request);
    expect(result).toEqual({
      submitted: false,
      reason: "error",
      detail: "worktree is no longer clean",
    });
  });
});
