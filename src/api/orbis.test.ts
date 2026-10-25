import { describe, expect, it, vi } from "vitest";
import { orbisRouter } from "./orbis.js";
import { createOrbisService } from "../orbis/service.js";

describe("Orbis HTTP surface", () => {
  const result = { content: [{ type: "text" as const, text: "page" }] };
  function fixture() {
    const call = vi.fn(async () => result);
    const app = orbisRouter(createOrbisService({ findSession: id => id === "live" ? { status: "active" } : null,
      token: () => "d".repeat(43), discover: async () => ({ url: "http://127.0.0.1:25001/", instanceId: "instance" }), call }));
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { app, call, post };
  }
  it("validates session_id and liveness, forwards successful results without cache", async () => {
    const f = fixture();
    expect((await f.post("/read", { sigillum: "s" })).status).toBe(400);
    expect((await f.post("/read", { session_id: "missing", sigillum: "s" })).status).toBe(403);
    expect(f.call).not.toHaveBeenCalled();
    const response = await f.post("/read", { session_id: "live", sigillum: "s" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
  });
  it("bounds bodies and rejects invalid JSON/action/identity override before I/O", async () => {
    const f = fixture();
    const oversized = await f.post("/attach", { session_id: "live", sigillum: "x".repeat(33_000) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "orbis_invalid_request" });
    expect((await f.app.request("/read", { method: "POST", body: "{" })).status).toBe(400);
    expect((await f.post("/act", { session_id: "live", sigillum: "s", action: { type: "evaluate" } })).status).toBe(400);
    expect((await f.post("/attach", { session_id: "live", sigillum: "s", clientId: "other" })).status).toBe(400);
    expect((await f.post("/reveal", { session_id: "live", sigillum: "s", userUtteranceId: "invented" })).status).toBe(403);
    expect((await f.post("/search", { session_id: "live", sigillum: "s" })).status).toBe(404);
    expect(f.call).not.toHaveBeenCalled();
  });
  it("sanitizes unknown failures", async () => {
    const f = fixture();
    f.call.mockRejectedValue(new Error("private token URL?password=x"));
    expect(await (await f.post("/read", { session_id: "live", sigillum: "s" })).json()).toEqual({ error: "orbis_operation_failed" });
  });
});
