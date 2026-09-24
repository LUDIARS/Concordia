/** @implements spec/feature/task-workflow-v3.md — authenticated, bounded Actio I/O */

import { describe, expect, it, vi } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import { ActioTransport } from "./actio-transport.js";

const BINDING: ActioBinding = {
  repoPath: "E:/Document/Ars/Concordia", project: "Concordia", projectId: "project-1",
  ownerId: "owner-1", tokenEnv: "CONCORDIA_ACTIO_TASK_TOKEN", subsidiaryId: null, teamId: null,
};

const RUNNING = { name: "actio", state: "running", port: 5175 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `findService` returns the catalog entry; `resolveServicePort` reads its port. */
const catalog = (service: unknown) => ({ findService: vi.fn(async () => service) }) as never;

describe("ActioTransport", () => {
  const local: ActioBinding = { ...BINDING, ownerId: "actio-local", authMode: "loopback", tokenEnv: undefined };

  it("uses the catalog endpoint and validates explicit loopback identity before writing", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "actio-local", localMode: true, access: "loopback" }))
      .mockResolvedValueOnce(json({ task: { id: "t1" } }));
    const token = vi.fn();
    const transport = new ActioTransport(catalog({ ...RUNNING, port: 3000, catalog_snapshot: { port: 17880 } }), token, fetchImpl as never);
    await transport.request(local, "POST", "/api/tasks", { title: "x" });
    expect(token).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls as [string, RequestInit][]) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:17880\//);
      expect(init.headers).not.toHaveProperty("authorization");
      expect(init.redirect).toBe("error");
    }
  });

  it.each([
    { id: "actio-local" },
    { id: "actio-local", localMode: true, access: "cf-access" },
    { id: "actio-local", localMode: false, access: "loopback" },
    { id: "anonymous", localMode: true, access: "loopback" },
  ])("denies an unverified local identity before task I/O: %j", async (identity) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(identity));
    const transport = new ActioTransport(catalog(RUNNING), () => undefined, fetchImpl as never);
    await expect(transport.request(local, "POST", "/api/tasks", {})).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not mistake local-mode identity for bearer authentication", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: "owner-1", localMode: true, access: "loopback" }));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);
    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("authentication mode mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid catalog ports instead of using stale observations", async () => {
    const fetchImpl = vi.fn();
    const transport = new ActioTransport(catalog({ ...RUNNING, catalog_snapshot: { port: 0 } }), () => "token", fetchImpl as never);
    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("service unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("verifies the configured owner before running the requested operation", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockResolvedValueOnce(json({ task: { id: "t1" } }));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    expect(await transport.request(BINDING, "POST", "/api/tasks", { title: "x" })).toEqual({ task: { id: "t1" } });

    const [identityUrl, identityInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(identityUrl).toBe("http://127.0.0.1:5175/api/auth/me");
    expect((identityInit.headers as Record<string, string>).authorization).toBe("Bearer token");
    const [taskUrl, taskInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(taskUrl).toBe("http://127.0.0.1:5175/api/tasks");
    expect(taskInit.method).toBe("POST");
    expect(taskInit.body).toBe(JSON.stringify({ title: "x" }));
    expect(taskInit.redirect).toBe("error");
  });

  /** Actio continues an invalid token as anonymous, so a matching owner is the real check. */
  it("refuses to operate when the authenticated identity is not the configured owner", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: "anonymous" }));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("Actio task identity mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires a credential before contacting the service", async () => {
    const findService = vi.fn();
    const transport = new ActioTransport({ findService } as never, () => "   ", vi.fn() as never);

    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("Actio task credential is required");
    expect(findService).not.toHaveBeenCalled();
  });

  it("treats a stopped or unregistered service as unavailable, never as an empty result", async () => {
    const stopped = new ActioTransport(catalog({ ...RUNNING, state: "stopped" }), () => "token", vi.fn() as never);
    await expect(stopped.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("Actio task service unavailable");

    const missing = new ActioTransport(catalog(null), () => "token", vi.fn() as never);
    await expect(missing.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("Actio task service unavailable");
  });

  it("surfaces the rejected status without leaking the response body", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockResolvedValueOnce(json({ secret: "task body" }, 403));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, "GET", "/api/tasks"))
      .rejects.toThrow("Actio task request rejected (403)");
  });

  /** A write may have committed; the caller must retry with the same source identity. */
  it("reports a transport failure as an unknown outcome", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockRejectedValueOnce(new Error("socket hang up"));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, "POST", "/api/tasks", {}))
      .rejects.toThrow("Actio task request outcome unknown; reconcile using the same task identity");
  });
});
