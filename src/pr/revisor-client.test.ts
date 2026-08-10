import { describe, expect, it, vi } from "vitest";
import {
  createRevisorClientFromEnv,
  RevisorClient,
  type RevisorReviewRequest,
} from "./revisor-client.js";
import { RevisorMergeError } from "./revisor-merge-outcome.js";

const request: RevisorReviewRequest = {
  repository: "LUDIARS/Concordia",
  number: 398,
  head_sha: "a".repeat(40),
  head_ref: "feat/pr-local-gate",
  head_repository: "LUDIARS/Concordia",
  base_ref: "main",
  pull_request_url: "https://github.com/LUDIARS/Concordia/pull/398",
  review_mode: "full",
};

describe("RevisorClient", () => {
  it("resolves the live Excubitor port and authenticates the enqueue request", async () => {
    const findService = vi.fn(async () => ({
      code: "revisor",
      name: "Revisor",
      port: 4240,
      state: "running",
    }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "job-1",
      status: "queued",
      check_url: "https://github.com/checks/1",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }));
    const client = new RevisorClient({
      excubitor: { findService },
      token: "local-secret",
      fetchImpl,
    });

    await expect(client.enqueue(request)).resolves.toEqual({
      id: "job-1",
      status: "queued",
      check_url: "https://github.com/checks/1",
    });
    expect(findService).toHaveBeenCalledWith("revisor");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4240/v1/pr-gate/jobs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer local-secret",
          "x-concordia-actor": "concordia",
        }),
        body: JSON.stringify(request),
      }),
    );
  });

  // 読み取り (local PR 一覧) に token は要らない。 null を返していたため、 秘密を配れない
  // だけで PRs ページの Revisor セクションが configured=false のまま出なかった。
  it("creates an integration even when the process secret is absent", () => {
    expect(createRevisorClientFromEnv({ findService: vi.fn() }, {})).toBeInstanceOf(RevisorClient);
  });

  // 読み取りが token 不要になっても書き込みは必須。 空の `Bearer ` を投げて 401 にせず、
  // 「秘密が未配布」と読める理由で失敗させる。
  it("refuses to enqueue without a token instead of sending an empty bearer", async () => {
    const fetchImpl = vi.fn();
    const client = new RevisorClient({ excubitor: { findService: vi.fn() }, fetchImpl });

    await expect(client.enqueue(request)).rejects.toThrow("token is required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Excubitor は state=running でも top-level port を null で返すことがある (catalog が正本)。
  it("falls back to the catalog port when the observed port is missing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ pullRequests: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new RevisorClient({
      excubitor: {
        findService: vi.fn(async () => ({
          code: "revisor",
          name: "Revisor",
          port: null,
          state: "running",
          catalog_snapshot: { port: 4240 },
        })),
      },
      fetchImpl,
    });

    await expect(client.listLocalPrs()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4240/v1/local-prs",
      // token 未設定なら authorization ヘッダ自体を付けない。
      expect.objectContaining({ headers: { "x-concordia-actor": "concordia" } }),
    );
  });

  it("lists local PRs without disclosing the workflow token and drops malformed rows", async () => {
    const findService = vi.fn(async () => ({
      code: "revisor",
      name: "Revisor",
      port: 4240,
      state: "running",
    }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      pullRequests: [
        { id: "lpr-1", number: 3, repository: "LUDIARS/Concordia", checkStatus: "test_ok" },
        { id: "lpr-2", number: "not-a-number", repository: "LUDIARS/Concordia" },
        null,
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new RevisorClient({ excubitor: { findService }, token: "local-secret", fetchImpl });

    const prs = await client.listLocalPrs();
    expect(prs.map((pr) => pr.id)).toEqual(["lpr-1"]);
    expect(await client.baseUrl()).toBe("http://127.0.0.1:4240");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4240/v1/local-prs",
      expect.objectContaining({
        headers: { "x-concordia-actor": "concordia" },
      }),
    );
  });

  it("fails the local PR listing when Revisor answers with an error or a non-array body", async () => {
    const excubitor = {
      findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })),
    };

    const failing = new RevisorClient({
      excubitor,
      token: "local-secret",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    });
    await expect(failing.listLocalPrs()).rejects.toThrow("(401): unauthorized");

    const malformed = new RevisorClient({
      excubitor,
      token: "local-secret",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ pullRequests: null }), { status: 200 })),
    });
    await expect(malformed.listLocalPrs()).rejects.toThrow("invalid local PR listing");
  });

  it("rejects a missing catalog port without sending a request", async () => {
    const fetchImpl = vi.fn();
    const client = new RevisorClient({
      excubitor: {
        findService: vi.fn(async () => ({
          code: "revisor",
          name: "Revisor",
          port: null,
          state: "stopped",
        })),
      },
      token: "local-secret",
      fetchImpl,
    });

    await expect(client.enqueue(request)).rejects.toThrow("has no valid port");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the resolved port and token for an explicit local PR merge", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const client = new RevisorClient({
      excubitor: { findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })) },
      token: "local-secret",
      fetchImpl,
    });
    await expect(client.mergeLocalPr("local/pr 1")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4240/v1/local-prs/local%2Fpr%201/merge",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer local-secret" }) }),
    );
  });

  it("carries the Revisor reason and status on a refused merge", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "The head conflicts with the current 'main'." }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    const client = new RevisorClient({
      excubitor: { findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })) },
      token: "local-secret",
      fetchImpl,
    });

    // 分類は呼び出し側 (classifyMergeFailure) の仕事。 client は素材を落とさず渡す。
    const error = await client.mergeLocalPr("pr-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevisorMergeError);
    expect((error as RevisorMergeError).status).toBe(409);
    expect((error as RevisorMergeError).revisorError).toContain("conflicts");
    expect((error as RevisorMergeError).timedOut).toBe(false);
  });

  it("marks a merge that ran past its own deadline as timed out", async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
    }));
    const client = new RevisorClient({
      excubitor: { findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })) },
      token: "local-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      mergeTimeoutMs: 5,
    });

    const error = await client.mergeLocalPr("pr-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevisorMergeError);
    // status を持たない = 応答が返っていない。 timedOut がそれを「到達不能」と分ける。
    expect((error as RevisorMergeError).timedOut).toBe(true);
    expect((error as RevisorMergeError).status).toBeNull();
  });

  it("keeps merges on a longer deadline than reads", async () => {
    // マージは隔離 clone の準備から公開までを同期実行するので、 読み取りと同じ上限だと
    // Revisor が完走している最中に打ち切ってしまう (Peregrinatio#408)。
    const timers: number[] = [];
    const client = new RevisorClient({
      excubitor: { findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })) },
      token: "local-secret",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      timers.push(ms ?? 0);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      await client.listLocalPrs().catch(() => undefined);
      await client.mergeLocalPr("pr-1");
    } finally {
      setTimeoutSpy.mockRestore();
    }
    const [readDeadline, mergeDeadline] = timers;
    expect(mergeDeadline).toBeGreaterThan(readDeadline);
  });
});
