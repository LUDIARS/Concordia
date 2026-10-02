import { describe, expect, it, vi } from "vitest";
import {
  classifyRevisorRequestFailure,
  requestRevisorJson,
  revisorFailureReason,
  RevisorRequestError,
} from "./revisor-http.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const base = { url: "http://127.0.0.1:4240/v1/local-prs?state=open", label: "Revisor listing", timeoutMs: 1_000 };

describe("requestRevisorJson", () => {
  it("returns the JSON body on success", async () => {
    const body = await requestRevisorJson({ ...base, fetchImpl: vi.fn(async () => json({ pullRequests: [] })) });
    expect(body).toEqual({ pullRequests: [] });
  });

  it("reports a request aborted by its own deadline as timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
    }));
    const error = await requestRevisorJson({ ...base, timeoutMs: 5, fetchImpl }).catch((e: unknown) => e);
    expect(revisorFailureReason(error)).toBe("timeout");
    expect((error as Error).message).toContain("timed out after 5ms");
  });

  it("reports a connection failure as unreachable", async () => {
    const error = await requestRevisorJson({
      ...base,
      fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); }),
    }).catch((e: unknown) => e);
    expect(revisorFailureReason(error)).toBe("unreachable");
    expect((error as Error).message).toContain("fetch failed");
  });

  it("reports an error response as http_error and keeps the status-bearing message", async () => {
    const error = await requestRevisorJson({
      ...base,
      fetchImpl: vi.fn(async () => json({ error: "busy" }, 503)),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevisorRequestError);
    expect(revisorFailureReason(error)).toBe("http_error");
    expect((error as RevisorRequestError).status).toBe(503);
    expect((error as Error).message).toBe("Revisor listing failed (503): busy");
  });

  it("returns null for 404 only when the caller allows it", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "not_found" }, 404));
    expect(await requestRevisorJson({ ...base, fetchImpl, allowNotFound: true })).toBeNull();
    await expect(requestRevisorJson({ ...base, fetchImpl })).rejects.toThrow("failed (404)");
  });

  it("does not classify foreign errors", () => {
    expect(revisorFailureReason(new Error("boom"))).toBeNull();
  });

  it("classifies by the deadline flag, not by the error type", () => {
    expect(classifyRevisorRequestFailure(true)).toBe("timeout");
    expect(classifyRevisorRequestFailure(false)).toBe("unreachable");
  });
});
