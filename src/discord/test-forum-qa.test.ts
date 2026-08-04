import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow } from "../db/discord-test-surfaces-repo.js";
import { createTestForumQaHooks, resolveCandidateRepoPath } from "./test-forum-qa.js";
import type { TestForumCandidate } from "./test-forum-reconcile.js";

describe("resolveCandidateRepoPath", () => {
  const parent = dirname(process.cwd());
  const self = basename(process.cwd());

  it("finds the local clone of `org/name` under a workspace root", () => {
    expect(resolveCandidateRepoPath([parent], `LUDIARS/${self}`)).toBe(join(parent, self));
  });

  it("returns null when no root holds the repository", () => {
    expect(resolveCandidateRepoPath([parent], "LUDIARS/no-such-repo-xyz")).toBeNull();
  });

  it("refuses a repository name that would escape the workspace root", () => {
    // 解決結果は spawn する QA セッションの cwd になる。 `..` 等でワークスペース外を
    // 指させない (repository 名は Revisor 由来で Cc は検証していない)。
    expect(resolveCandidateRepoPath([process.cwd()], "LUDIARS/..")).toBeNull();
    expect(resolveCandidateRepoPath([process.cwd()], "LUDIARS/.")).toBeNull();
    expect(resolveCandidateRepoPath([process.cwd()], "LUDIARS/a b")).toBeNull();
  });
});

function candidate(overrides: Partial<TestForumCandidate> = {}): TestForumCandidate {
  return {
    repoOrigin: "LUDIARS/no-such-repo-xyz",
    prNumber: 42,
    pullRequestId: "local-pr-42",
    title: "Test Forum",
    url: null,
    headBranch: "feat/test-forum",
    headSha: "sha-1",
    repoRootPath: "E:/Document/Ars/no-such-repo-xyz",
    worktreePath: null,
    detail: null,
    contentHash: "hash-1",
    ...overrides,
  };
}

function surfaceRow(qaRunId: string | null): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: "sha-1",
    repo_root_path: "E:/Document/Ars/Concordia",
    head_branch: "feat/test-forum",
    worktree_path: null,
    thread_id: "thread-42",
    status: "open",
    created_at: 1,
    closed_at: null,
    close_reason: null,
    content_hash: "hash-1",
    qa_run_id: qaRunId,
    run_state: "candidate",
    provider: "codex",
    model: "sol",
    effort: "xhigh",
    session_id: null,
    local_pr_id: null,
    controls_message_id: null,
  };
}

/** `callConcordia` は素の global fetch を使うので、 経路ごと差し替えて検証する。 */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const result = handler(url, init);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const status = result.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(result.body),
    } as Response;
  }));
  return calls;
}

function hooks(log = { info: vi.fn(), warn: vi.fn() }) {
  return {
    log,
    qa: createTestForumQaHooks({
      concordiaUrl: "http://127.0.0.1:11111",
      workspaceRoots: [],
      subsidiaryId: null,
      log,
    }),
  };
}

describe("createTestForumQaHooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("spawns the test-qa delegation for a new post and returns the run id", async () => {
    const calls = stubFetch(() => ({ body: { ok: true, run: { id: "run-qa-1" } } }));
    const { qa } = hooks();

    expect(await qa.start(candidate(), "thread-42")).toBe("run-qa-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:11111/v1/delegation/invoke");
    expect(calls[0].body).toMatchObject({
      call_name: "test-qa",
      spawn: true,
      args: { repository: "LUDIARS/no-such-repo-xyz", pr_number: "42", thread_id: "thread-42" },
    });
    // ローカルクローンが見つからない候補では cwd を捏造せず、 既定の解決に委ねる。
    expect(calls[0].body).not.toHaveProperty("cwd");
  });

  it("returns null (post stays published) when the spawn fails", async () => {
    stubFetch(() => ({ status: 400, body: { error: "unknown call_name" } }));
    const { qa, log } = hooks();

    expect(await qa.start(candidate(), "thread-42")).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("ends the child session of the recorded QA run when the post closes", async () => {
    const calls = stubFetch((url) => (url.includes("/v1/delegation/runs/")
      ? { body: { run: { child_session_id: "sess-1" } } }
      : { body: { ok: true } }));
    const { qa } = hooks();

    await qa.end(surfaceRow("run-qa-9"));
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /v1/delegation/runs/run-qa-9",
      "DELETE /v1/sessions/sess-1",
    ]);
  });

  it("is a no-op without a QA run, and tolerates an already-ended session", async () => {
    const noRun = stubFetch(() => ({ body: {} }));
    const { qa } = hooks();
    await qa.end(surfaceRow(null));
    expect(noRun).toHaveLength(0);

    vi.unstubAllGlobals();
    // run は残っているが child session は既に end-session 済み → DELETE の失敗は正常系。
    stubFetch((url) => (url.includes("/v1/delegation/runs/")
      ? { body: { run: { child_session_id: "sess-1" } } }
      : { status: 404, body: { error: "not_found" } }));
    const { qa: qa2, log } = hooks();
    await expect(qa2.end(surfaceRow("run-qa-9"))).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
