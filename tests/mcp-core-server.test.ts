import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildCoreServer, callConcordia } from "../src/mcp/core-server.js";

describe("concordia-core MCP server", () => {
  it("buildCoreServer returns an McpServer without throwing", () => {
    const s = buildCoreServer();
    expect(s).toBeDefined();
    // McpServer exposes a `.server` property for the underlying Server. We don't
    // rely on internals further than that — the real shape is asserted by
    // typecheck.
    expect((s as unknown as { server: unknown }).server).toBeDefined();
  });

  it("buildCoreServer registers all expected tools", () => {
    const s = buildCoreServer();
    // _registeredTools is internal but stable across @modelcontextprotocol/sdk
    // 0.x. If the SDK renames it the test will surface that early.
    const internal = s as unknown as { _registeredTools: Record<string, unknown> };
    expect(internal._registeredTools).toBeDefined();
    const names = Object.keys(internal._registeredTools).sort();
    // リスト自体でツール名を網羅検証する (個数はリスト長から自動導出)
    const expectedTools = [
      "concordia_get_conflicts",
      "concordia_get_pending_tasks",
      "concordia_get_session",
      "concordia_get_session_log",
      "concordia_get_session_stat",
      "concordia_list_all_stats",
      "concordia_list_session_logs",
      "concordia_list_sessions",
      "concordia_post_chat",
      "concordia_pr_queue",
      "concordia_recent_chat",
    ];
    expect(names).toEqual(expectedTools.slice().sort());
  });
});

describe("callConcordia", () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.CONCORDIA_BASE_URL;

  beforeEach(() => {
    process.env.CONCORDIA_BASE_URL = "http://127.0.0.1:17330";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.CONCORDIA_BASE_URL;
    else process.env.CONCORDIA_BASE_URL = originalBase;
  });

  it("returns ok=true with parsed JSON body on 2xx", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ sessions: [{ id: "abc" }] }),
    })) as unknown as typeof fetch;

    const r = await callConcordia("GET", "/v1/sessions");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sessions: [{ id: "abc" }] });
  });

  it("returns ok=false on non-2xx with raw body when not JSON", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => "not found",
    })) as unknown as typeof fetch;

    const r = await callConcordia("GET", "/v1/sessions/missing");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.body).toBe("not found");
  });

  it("returns ok=false with descriptive error when fetch throws (Concordia down)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const r = await callConcordia("GET", "/v1/sessions");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.body).toMatchObject({ error: expect.stringContaining("ECONNREFUSED") });
  });

  it("strips trailing slash from CONCORDIA_BASE_URL before composing the URL", async () => {
    process.env.CONCORDIA_BASE_URL = "http://127.0.0.1:17330/";
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => "{}" } as never;
    }) as unknown as typeof fetch;

    await callConcordia("GET", "/v1/sessions");
    expect(calls).toHaveLength(1);
    // No double slash before /v1.
    expect(calls[0]).toBe("http://127.0.0.1:17330/v1/sessions");
  });

  it("sends body as JSON on POST", async () => {
    const captured: { method?: string; body?: string } = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      const i = init as { method: string; body: string };
      captured.method = i.method;
      captured.body = i.body;
      return { ok: true, status: 200, text: async () => "{}" } as never;
    }) as unknown as typeof fetch;

    await callConcordia("POST", "/v1/chat", { channel: "system", text: "hi", author_label: "test" });
    expect(captured.method).toBe("POST");
    expect(JSON.parse(captured.body ?? "")).toEqual({ channel: "system", text: "hi", author_label: "test" });
  });
});
