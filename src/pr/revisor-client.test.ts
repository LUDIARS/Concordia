import { describe, expect, it, vi } from "vitest";
import {
  createRevisorClientFromEnv,
  RevisorClient,
  type RevisorReviewRequest,
} from "./revisor-client.js";

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

  it("does not create an integration when the process secret is absent", () => {
    expect(createRevisorClientFromEnv(
      { findService: vi.fn() },
      {},
    )).toBeNull();
  });

  it("lists local PRs from the catalog port and drops malformed rows", async () => {
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
        headers: expect.objectContaining({ authorization: "Bearer local-secret" }),
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
});
