import { describe, expect, it, vi } from "vitest";
import { packageUpdatesRouter } from "./package-updates.js";
import type { PackageUpdateLedger } from "../deploy/package-updates.js";

const TOKEN = "dispatch-token";
const body = { source: "ergo-watch", runId: "run-1", messages: [{ text: "pkg-a 1.2.0 <@123>", private: false }] };

function ledger(): PackageUpdateLedger {
  const keys = new Set<string>();
  return {
    claim: (runId, index) => { const key = `${runId}:${index}`; if (keys.has(key)) return false; keys.add(key); return true; },
    release: (runId, index) => { keys.delete(`${runId}:${index}`); },
  };
}

function router(overrides: { configured?: boolean } = {}) {
  const post = vi.fn(async (_content: string) => {});
  const app = packageUpdatesRouter({
    ledger: ledger(),
    configured: () => overrides.configured ?? true,
    post,
    authorize: (header) => header === TOKEN,
  });
  const send = (payload: unknown, token: string | null = TOKEN) => app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-excubitor-token": token } : {}) },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { post, send };
}

describe("POST /v1/events/package-updates", () => {
  it("rejects a request without the excubitor token", async () => {
    const { post, send } = router();
    const response = await send(body, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect((await send(body, "wrong")).status).toBe(401);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed json", "{"],
    ["wrong source", { ...body, source: "other" }],
    ["empty runId", { ...body, runId: "" }],
    ["long runId", { ...body, runId: "r".repeat(129) }],
    ["no messages", { ...body, messages: [] }],
    ["too many messages", { ...body, messages: Array.from({ length: 21 }, () => ({ text: "x", private: false })) }],
    ["empty text", { ...body, messages: [{ text: "", private: false }] }],
    ["long text", { ...body, messages: [{ text: "x".repeat(1901), private: false }] }],
    ["missing private", { ...body, messages: [{ text: "x" }] }],
    ["unknown field", { ...body, extra: 1 }],
    ["unknown message field", { ...body, messages: [{ text: "x", private: false, url: "u" }] }],
  ])("rejects an invalid body (%s)", async (_label, payload) => {
    const { post, send } = router();
    const response = await send(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_body" });
    expect(post).not.toHaveBeenCalled();
  });

  it("returns 503 when the deploy notify channel is not configured", async () => {
    const { post, send } = router({ configured: false });
    const response = await send(body);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
    expect(post).not.toHaveBeenCalled();
  });

  it("delivers once with mentions neutralized and reports a duplicate on resend", async () => {
    const { post, send } = router();
    const first = await send(body);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ delivered: 1, failed: [], duplicate: false });
    expect(post.mock.calls[0]?.[0]).not.toContain("<@");
    const second = await send(body);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ delivered: 0, failed: [], duplicate: true });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
