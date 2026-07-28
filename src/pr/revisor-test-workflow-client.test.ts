import { describe, expect, it, vi } from "vitest";
import {
  createRevisorTestWorkflowClientFromEnv,
  RevisorTestWorkflowClient,
} from "./revisor-test-workflow-client.js";

const product = {
  repository: "LUDIARS/Concordia",
  pullRequestId: "local-pr-1",
  number: 1,
  title: "Synchronize Test Forum",
  status: "Open / Test OK",
  reviewedHeadSha: "a".repeat(40),
  updatedAt: "2026-07-28T00:00:00.000Z",
} as const;

describe("RevisorTestWorkflowClient", () => {
  it("reads Open / Test OK products from the live Excubitor service port", async () => {
    const findService = vi.fn(async () => ({
      code: "revisor",
      name: "Revisor",
      port: 4240,
      state: "running",
    }));
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ products: [product] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
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

  it("does not create a source when the workflow secret is absent", () => {
    expect(createRevisorTestWorkflowClientFromEnv(
      { findService: vi.fn() },
      {},
    )).toBeNull();
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
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ products: [{ ...product, reviewedHeadSha: null }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )),
    });

    await expect(client.listProducts()).rejects.toThrow("invalid test workflow response");
  });
});
