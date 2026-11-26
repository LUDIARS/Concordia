/** @implements spec/feature/task-workflow-v3.md — authenticated, bounded Actio I/O */

import { describe, expect, it, vi } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import { ActioTransport } from "./actio-transport.js";
import { ACTING_FOR_HEADER, withActingFor } from "./actio-acting-for.js";

const BINDING: ActioBinding = {
  repoPath: "E:/Document/Ars/Concordia", project: "Concordia", projectId: "project-1",
  ownerId: "owner-1", tokenEnv: "CONCORDIA_ACTIO_TASK_TOKEN", subsidiaryId: null, teamId: null,
};

const RUNNING = { name: "actio", state: "running", port: 5175 };
const fixedNow = () => 1_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `findService` returns the catalog entry; `resolveServicePort` reads its port. */
const catalog = (service: unknown) => ({ findService: vi.fn(async () => service) }) as never;

describe("ActioTransport", () => {
  const local: ActioBinding = { ...BINDING, ownerId: "actio-local", authMode: "loopback", tokenEnv: undefined };

  it("verifies local team leadership before writing and preserves the team", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "actio-local", localMode: true, access: "loopback" }))
      .mockResolvedValueOnce(json({ teams: [{ id: "team", role: "leader" }] }))
      .mockResolvedValueOnce(json({ task: { id: "t1", teamId: "team" } }));
    const transport = new ActioTransport(catalog(RUNNING), () => undefined, fetchImpl as never);
    await expect(transport.request({ ...local, teamId: "team" }, "POST", "/api/tasks", { teamId: "team" }))
      .resolves.toEqual({ task: { id: "t1", teamId: "team" } });
    expect(fetchImpl.mock.calls[1]?.[0]).toMatch(/\/api\/teams$/);
    expect(fetchImpl.mock.calls[2]?.[1].body).toBe(JSON.stringify({ teamId: "team" }));
  });

  it.each([{ teams: [] }, { teams: [{ id: "other", role: "leader" }] }, { teams: [{ id: "team", role: "member" }] }])(
    "rejects missing or insufficient local team access: %j", async ({ teams }) => {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(json({ id: "actio-local", localMode: true, access: "loopback" }))
        .mockResolvedValueOnce(json({ teams }));
      const transport = new ActioTransport(catalog(RUNNING), () => undefined, fetchImpl as never);
      await expect(transport.request({ ...local, teamId: "team" }, "POST", "/api/tasks", {}))
        .rejects.toThrow("team access mismatch");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

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

  it("uses Actio's own liveness when the catalog state disagrees, and logs the catalog state", async () => {
    const findService = vi.fn()
      .mockResolvedValueOnce(RUNNING)
      .mockResolvedValue({ ...RUNNING, state: "unknown" });
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("/api/health/live")
      ? json({ status: "ok", service: "actio" }) : json({ id: "owner-1" })));
    const log = vi.fn();
    const transport = new ActioTransport({ findService } as never, () => "token", fetchImpl as never, 10_000, fixedNow, log);
    await transport.request(BINDING, "GET", "/api/tasks");
    await expect(transport.request(BINDING, "GET", "/api/tasks")).resolves.toEqual({ id: "owner-1" });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toContain("http://127.0.0.1:5175/api/health/live");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("catalog state=unknown"));
    expect(log.mock.calls.join("\n")).not.toContain("token");
  });

  it("probes the previously resolved port when the catalog drops the endpoint", async () => {
    const findService = vi.fn()
      .mockResolvedValueOnce(RUNNING)
      .mockResolvedValue({ name: "actio", state: "stopped" });
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("/api/health/live")
      ? json({ status: "ok", service: "actio" }) : json({ id: "owner-1" })));
    const transport = new ActioTransport({ findService } as never, () => "token", fetchImpl as never, 10_000, fixedNow, vi.fn());
    await transport.request(BINDING, "GET", "/api/tasks");
    await transport.request(BINDING, "GET", "/api/tasks");
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:5175\/api\/tasks$/);
  });

  it("stays unavailable when the catalog disagrees and nothing answers as Actio", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "ok", service: "other" }));
    const log = vi.fn();
    const transport = new ActioTransport(catalog({ ...RUNNING, state: "stopped" }), () => "token", fetchImpl as never, 10_000, fixedNow, log);
    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("Actio task service unavailable");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no live Actio endpoint"));
  });

  it("reports a failed catalog lookup apart from a stopped Actio", async () => {
    const findService = vi.fn(async () => { throw new Error("excubitor timeout"); });
    const transport = new ActioTransport({ findService } as never, () => "token", vi.fn() as never);
    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("Actio service lookup failed");
  });

  it("reuses a recently resolved port while the catalog lookup fails, then gives up after the TTL", async () => {
    const findService = vi.fn()
      .mockResolvedValueOnce(RUNNING)
      .mockRejectedValue(new Error("excubitor timeout"));
    const fetchImpl = vi.fn(async (_url: string) => json({ id: "owner-1" }));
    let now = 1_000;
    const transport = new ActioTransport({ findService } as never, () => "token", fetchImpl as never, 10_000, () => now);
    await transport.request(BINDING, "GET", "/api/tasks");
    now += 60_000;
    await transport.request(BINDING, "GET", "/api/tasks");
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:5175\//);
    now += 10 * 60_000;
    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow("Actio service lookup failed");
  });

  it("surfaces the rejected status without leaking the response body", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockResolvedValueOnce(json({ secret: "task body" }, 403));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, "GET", "/api/tasks"))
      .rejects.toThrow("Actio task request rejected (403)");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /** A write may have committed; the caller must retry with the same source identity. */
  it.each(["POST", "PATCH"] as const)("reports a %s transport failure as an unknown outcome", async (method) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockRejectedValueOnce(new Error("socket hang up"));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, method, "/api/tasks", {}))
      .rejects.toThrow("Actio task request outcome unknown; reconcile using the same task identity");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a GET connection failure without exposing the underlying error", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockRejectedValue(new TypeError("private socket detail"));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow(/^Actio read connection failed$/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a transient identity failure and a temporary task response", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockResolvedValueOnce(json({ secret: "unavailable" }, 503))
      .mockResolvedValueOnce(json({ tasks: [] }));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, "GET", "/api/tasks")).resolves.toEqual({ tasks: [] });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/auth/me", "/api/auth/me", "/api/tasks", "/api/tasks",
    ]);
  });

  it("reports an expired GET response body as a read timeout", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockImplementationOnce(async (_url: string, { signal }: { signal: AbortSignal }) => ({
        ok: true,
        json: () => new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      }));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never, 5);

    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow(/^Actio read timed out$/);
  });

  it("reports invalid JSON from a GET as an invalid response", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockResolvedValueOnce(new Response("private invalid JSON"));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);

    await expect(transport.request(BINDING, "GET", "/api/tasks")).rejects.toThrow(/^Invalid Actio read response$/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("ActioTransport acting-for (AT-CC-ACTING-FOR)", () => {
  const local: ActioBinding = { ...BINDING, ownerId: "actio-local", authMode: "loopback", tokenEnv: undefined };

  it("adds the requester only to the local write, not to identity checks", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "actio-local", localMode: true, access: "loopback" }))
      .mockResolvedValueOnce(json({ task: { id: "t1" } }));
    const transport = new ActioTransport(catalog(RUNNING), () => undefined, fetchImpl as never);
    await withActingFor({ platform: "discord", userId: "42" }, () => transport.request(local, "POST", "/api/tasks", {}));
    const [identity, write] = fetchImpl.mock.calls as [string, RequestInit][];
    expect(identity?.[1].headers).not.toHaveProperty(ACTING_FOR_HEADER);
    expect(write?.[1].headers).toHaveProperty(ACTING_FOR_HEADER, "discord:42");
  });

  it("does not send the requester with a bearer binding", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ id: "owner-1" }))
      .mockResolvedValueOnce(json({ task: { id: "t1" } }));
    const transport = new ActioTransport(catalog(RUNNING), () => "token", fetchImpl as never);
    await withActingFor({ platform: "discord", userId: "42" }, () => transport.request(BINDING, "POST", "/api/tasks", {}));
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[1].headers).not.toHaveProperty(ACTING_FOR_HEADER);
  });
});
