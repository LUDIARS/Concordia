import { describe, expect, it, vi } from "vitest";
import {
  parseLocalPrDetail,
  createRevisorTestWorkflowClient,
  createRevisorTestWorkflowClientFromEnv,
  RevisorTestWorkflowClient,
} from "./revisor-test-workflow-client.js";

const projection = {
  repository: "LUDIARS/Concordia",
  pullRequestId: "local-pr-1",
  number: 1,
  title: "Synchronize Test Forum",
  status: "Open / Test OK",
  reviewedHeadSha: "a".repeat(40),
  updatedAt: "2026-07-28T00:00:00.000Z",
} as const;

const product = {
  ...projection,
  headRef: "feat/test-forum",
  repositoryRootPath: "E:/Document/Ars/Concordia",
} as const;

function responseFor(
  input: string | URL | Request,
  products: readonly unknown[] = [projection],
): Response {
  const url = String(input);
  if (url.endsWith("/v1/test-workflow")) {
    return new Response(JSON.stringify({ products }), { status: 200 });
  }
  if (url.endsWith("/v1/local-prs")) {
    return new Response(JSON.stringify({
      pullRequests: [{
        id: projection.pullRequestId,
        repository: projection.repository,
        headRef: product.headRef,
      }],
    }), { status: 200 });
  }
  if (url.endsWith("/v1/repositories")) {
    return new Response(JSON.stringify({
      repositories: [{
        repository: projection.repository,
        rootPath: product.repositoryRootPath,
      }],
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
}

describe("RevisorTestWorkflowClient", () => {
  it("reads Open / Test OK products from the live Excubitor service port", async () => {
    const findService = vi.fn(async () => ({
      code: "revisor",
      name: "Revisor",
      port: 4240,
      state: "running",
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => responseFor(input));
    const client = new RevisorTestWorkflowClient({
      excubitor: { findService },
      token: "workflow-secret",
      fetchImpl,
    });

    await expect(client.listProducts()).resolves.toEqual([product]);
    expect(findService).toHaveBeenCalledWith("revisor");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4240/v1/test-workflow",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer workflow-secret",
          "x-concordia-actor": "concordia",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  // Revisor は loopback からの読み取りに token を要求しない。 秘密を配れないだけで
  // Test Forum 同期が止まっていた (source unavailable) ので、 未設定でも source を作る。
  it("creates a source even when no workflow secret is configured", () => {
    expect(createRevisorTestWorkflowClientFromEnv(
      { findService: vi.fn() },
      {},
    )).toBeInstanceOf(RevisorTestWorkflowClient);
  });

  it("sends the configured env secret as a Bearer token", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => responseFor(input, []));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createRevisorTestWorkflowClientFromEnv(
        {
          findService: vi.fn(async () => ({
            code: "revisor",
            name: "Revisor",
            port: 4240,
            state: "running",
          })),
        },
        { CONCORDIA_REVISOR_WORKFLOW_TOKEN: "  workflow-secret  " },
      );

      await expect(client.listProducts()).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:4240/v1/test-workflow",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer workflow-secret" }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits the authorization header when no secret is configured", async () => {
    let sent: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = (init?.headers ?? {}) as Record<string, string>;
      return responseFor(_url, []);
    });
    const client = new RevisorTestWorkflowClient({
      excubitor: {
        findService: vi.fn(async () => ({
          code: "revisor",
          name: "Revisor",
          port: 4240,
          state: "running",
        })),
      },
      token: "",
      fetchImpl,
    });

    await expect(client.listProducts()).resolves.toEqual([]);
    expect(sent).not.toHaveProperty("authorization");
    expect(sent).toMatchObject({ "x-concordia-actor": "concordia" });
  });

  it("rejects malformed products instead of silently dropping them", async () => {
    const client = new RevisorTestWorkflowClient({
      excubitor: {
        findService: vi.fn(async () => ({
          code: "revisor",
          name: "Revisor",
          port: 4240,
          state: "running",
        })),
      },
      token: "workflow-secret",
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        responseFor(input, [{ ...projection, reviewedHeadSha: null }])),
    });

    await expect(client.listProducts()).rejects.toThrow("invalid test workflow response");
  });

  // token を起動時に固定すると、 設定画面で入れた値がプロセス再起動まで効かない。
  // resolver はリクエストごとに呼ばれること (= 設定変更が次の同期から効くこと) を固定する。
  it("resolves the token per request so a config change applies without a restart", async () => {
    const findService = vi.fn(async () => ({
      code: "revisor",
      name: "Revisor",
      port: 4240,
      state: "running",
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => responseFor(input, []));
    let stored: string | undefined;
    const client = createRevisorTestWorkflowClient(
      { findService },
      () => stored,
      { fetchImpl },
    );

    await client.listProducts();
    stored = "  set-later  ";
    await client.listProducts();

    // mock は引数を宣言していない (typeof fetch へ代入するため) ので、 読むときに型を付ける。
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const headersOf = (index: number) => calls[index]![1].headers as Record<string, string>;
    expect(headersOf(0)).not.toHaveProperty("authorization");
    // trim も resolver 側で効く。
    expect(headersOf(3)).toMatchObject({ authorization: "Bearer set-later" });
  });
});

describe("parseLocalPrDetail", () => {
  it("extracts the decision summary from a Revisor local PR", () => {
    const detail = parseLocalPrDetail({
      author: "neco",
      headRef: "feat/x",
      baseRef: "main",
      body: "説明",
      decision: {
        label: "人間の判断が必要",
        blockers: ["動作確認が必要", 42, "リスク超過"],
        riskScore: 57,
        riskThreshold: 30,
        riskBandLabel: "high",
        runtimeVerificationRequired: true,
      },
      ci: [
        { name: "unit", status: "passed" },
        { name: "lint", status: "failed" },
        { name: "e2e", status: "skipped" },
      ],
      security: { status: "passed" },
      autoMerge: { merged: false, reason: "閾値超過" },
    });
    expect(detail).toEqual({
      author: "neco",
      headRef: "feat/x",
      baseRef: "main",
      body: "説明",
      decisionLabel: "人間の判断が必要",
      blockers: ["動作確認が必要", "リスク超過"],
      riskScore: 57,
      riskThreshold: 30,
      riskBandLabel: "high",
      runtimeVerificationRequired: true,
      testsPassed: 1,
      testsRan: 2,
      securityStatus: "passed",
      autoMerge: { merged: false, reason: "閾値超過" },
    });
  });

  it("degrades missing fields to nulls but rejects a non-object payload", () => {
    const detail = parseLocalPrDetail({ author: "neco" });
    expect(detail).toMatchObject({
      decisionLabel: null,
      blockers: [],
      riskScore: null,
      testsRan: null,
      autoMerge: null,
    });
    expect(parseLocalPrDetail(null)).toBeNull();
    expect(parseLocalPrDetail("text")).toBeNull();
  });

  it("tolerates early-QA rows (Open / In Review) in the workflow list", async () => {
    // Revisor の early QA (697a730) は審査中の行を products に混ぜて返す。
    // listProducts は Test OK だけを返し、混入で同期全体を落とさない。
    const early = {
      repository: "LUDIARS/Revisor",
      pullRequestId: "local-pr-2",
      number: 2,
      title: "under review",
      status: "Open / In Review",
      checkStatus: "queued",
      qaMode: "early",
      headSha: "b".repeat(40),
      reviewedHeadSha: null,
      updatedAt: "2026-08-04T00:00:00.000Z",
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      responseFor(input, [early, projection]));
    const client = new RevisorTestWorkflowClient({
      excubitor: { findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })) },
      fetchImpl,
    });

    await expect(client.listProducts()).resolves.toEqual([product]);
  });
});
