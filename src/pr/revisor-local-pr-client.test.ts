import { describe, expect, it, vi } from "vitest";

import { RevisorLocalPrClient } from "./revisor-local-pr-client.js";

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
      head_ref: "feat/thing",
      base_ref: "main",
    });
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

  it("rejects a listing that is not shaped like a local PR list", async () => {
    const client = new RevisorLocalPrClient({
      excubitor: { findService: findService() },
      fetchImpl: vi.fn(async () => json({ items: [] })),
    });

    await expect(client.listLocalPullRequests()).rejects.toThrow("invalid local PR listing");
  });
});
