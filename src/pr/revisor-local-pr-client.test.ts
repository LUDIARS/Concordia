import { describe, expect, it, vi } from "vitest";

import { createRevisorLocalPrClient, RevisorLocalPrClient } from "./revisor-local-pr-client.js";

const findService = () => vi.fn(async () => ({
  code: "revisor",
  name: "Revisor",
  port: 4240,
  state: "running",
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LOCAL_PR = {
  id: "local-pr-1",
  number: 8,
  repository: "LUDIARS/Concordia",
  headRef: "feat/thing",
  status: "open",
  checkStatus: "queued",
  sessionId: null,
  reviewLane: "standard",
};

describe("RevisorLocalPrClient", () => {
  it("submits to the Excubitor-resolved port with the workflow token and snake_case field names", async () => {
    const fetchImpl = vi.fn(async () => json({ pullRequest: LOCAL_PR }));
    const client = new RevisorLocalPrClient({
      excubitor: { findService: findService() },
      token: "workflow-secret",
      fetchImpl,
    });

    await expect(client.submitLocalPullRequest({
      repository: "LUDIARS/Concordia",
      title: "feat: thing",
      body: "session s-1",
      author: "concordia",
      sessionId: "s-1",
      headRef: "feat/thing",
      baseRef: "main",
    })).resolves.toEqual(LOCAL_PR);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4240/v1/local-prs");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer workflow-secret",
      "x-concordia-actor": "concordia",
      "content-type": "application/json",
    });
    // Revisor の受け口は snake_case。 camelCase のまま送ると base/head が落ちる。
    expect(JSON.parse(String(init.body))).toEqual({
      repository: "LUDIARS/Concordia",
      title: "feat: thing",
      body: "session s-1",
      author: "concordia",
      session_id: "s-1",
      head_ref: "feat/thing",
      base_ref: "main",
    });
  });

  it("sends fast_lane only for an explicit opt-in and supports queued promotion", async () => {
    const fetchImpl = vi.fn(async () => json({
      pullRequest: { ...LOCAL_PR, sessionId: "s-1", reviewLane: "fast" },
    }));
    const client = new RevisorLocalPrClient({
      excubitor: { findService: findService() },
      token: "workflow-secret",
      fetchImpl,
    });
    await client.submitLocalPullRequest({
      repository: "LUDIARS/Concordia",
      title: "変更を早く確認する",
      body: "## 実装内容\n- 変更。\n\n## 受け入れ条件\n- 確認。",
      author: "concordia",
      sessionId: "s-1",
      headRef: "feat/thing",
      fastLane: true,
    });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
      .toMatchObject({ fast_lane: true, session_id: "s-1" });

    await client.promoteLocalPullRequest("local-pr-1", "s-1");
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4240/v1/local-prs/local-pr-1/fast-lane");
    expect(JSON.parse(String(init.body))).toEqual({ session_id: "s-1" });
  });

  // 読み取りは loopback 限定で token 不要 — token 無しの環境でも一覧は動く。
  it("omits the authorization header when no token is configured", async () => {
    const fetchImpl = vi.fn(async () => json({ repositories: [] }));
    const client = new RevisorLocalPrClient({ excubitor: { findService: findService() }, fetchImpl });

    await expect(client.listRepositories()).resolves.toEqual([]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("defaults a missing base ref to main and drops malformed registrations", async () => {
    const client = new RevisorLocalPrClient({
      excubitor: { findService: findService() },
      fetchImpl: vi.fn(async () => json({
        repositories: [
          { repository: "LUDIARS/Concordia", rootPath: "E:/Document/Ars/Concordia" },
          { repository: "LUDIARS/Memoria", rootPath: "E:/Document/Ars/Memoria", baseRef: "develop" },
          { repository: "LUDIARS/Broken" },
        ],
      })),
    });

    await expect(client.listRepositories()).resolves.toEqual([
      { repository: "LUDIARS/Concordia", rootPath: "E:/Document/Ars/Concordia", baseRef: "main" },
      { repository: "LUDIARS/Memoria", rootPath: "E:/Document/Ars/Memoria", baseRef: "develop" },
    ]);
  });

  it("surfaces the Revisor error text on a failed submission", async () => {
    const client = new RevisorLocalPrClient({
      excubitor: { findService: findService() },
      token: "workflow-secret",
      fetchImpl: vi.fn(async () => json({ error: "worktree is not clean" }, 409)),
    });

    await expect(client.submitLocalPullRequest({
      repository: "LUDIARS/Concordia",
      title: "t",
      body: "b",
      author: "concordia",
      sessionId: "s-1",
      headRef: "feat/thing",
    })).rejects.toThrow("worktree is not clean");
  });

  // ポートは Excubitor catalog が正本。 未登録のまま 127.0.0.1:undefined を叩かない。
  it("fails loudly when Excubitor has no port for Revisor", async () => {
    const fetchImpl = vi.fn(async () => json({ pullRequests: [] }));
    const client = new RevisorLocalPrClient({
      excubitor: { findService: vi.fn(async () => null) },
      fetchImpl,
    });

    await expect(client.listLocalPullRequests()).rejects.toThrow("no valid port");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // 提出は token 必須の経路。 起動時に固定すると設定画面で入れた値が再起動まで効かない。
  // resolver がリクエストごとに呼ばれること (= 設定変更が次の提出から効くこと) を固定する。
  it("resolves the token per request so a config change applies without a restart", async () => {
    const fetchImpl = vi.fn(async () => json({ repositories: [] }));
    let stored: string | undefined;
    const client = new RevisorLocalPrClient({
      excubitor: { findService: findService() },
      token: () => stored,
      fetchImpl,
    });

    await client.listRepositories();
    stored = "  set-later  ";
    await client.listRepositories();

    const headersOf = (index: number) =>
      (fetchImpl.mock.calls[index] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headersOf(0)).not.toHaveProperty("authorization");
    // trim も resolver 経由で効く。
    expect(headersOf(1)).toMatchObject({ authorization: "Bearer set-later" });
  });

  // resolver 未指定の既定は env フォールバック (bootstrap 前 / DB 無しの経路)。
  it("falls back to the env token when no resolver is given", async () => {
    const fetchImpl = vi.fn(async () => json({ repositories: [] }));
    // factory は fetch を受け取らないので、 グローバルを差し替えてから生成する
    // (クライアントは constructor 時点の globalThis.fetch を捕まえる)。
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const client = createRevisorLocalPrClient(
        { findService: findService() },
        undefined,
        { CONCORDIA_REVISOR_WORKFLOW_TOKEN: "  env-secret  " },
      );
      await client.listRepositories();
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.headers).toMatchObject({ authorization: "Bearer env-secret" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a listing that is not shaped like a local PR list", async () => {
    const client = new RevisorLocalPrClient({
      excubitor: { findService: findService() },
      fetchImpl: vi.fn(async () => json({ items: [] })),
    });

    await expect(client.listLocalPullRequests()).rejects.toThrow("invalid local PR listing");
  });
});
