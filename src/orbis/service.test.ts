import { describe, expect, it, vi } from "vitest";
import { createOrbisService } from "./service.js";
import { authorizeOrbisRequest } from "./authorization.js";

function fixture() {
  const findSession = vi.fn((id: string): { status: string } | null => id === "live" ? { status: "active" } : null);
  const token = vi.fn((): string | undefined => "d".repeat(43));
  const discover = vi.fn(async () => ({ url: "http://127.0.0.1:25001/", instanceId: "instance" }));
  const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "result" }] }));
  return { findSession, token, discover, call, service: createOrbisService({ findSession, token, discover, call }) };
}

describe("Orbis session use case", () => {
  it("derives peer identity from the live session and supports blocked sessions", async () => {
    const f = fixture();
    await f.service.execute("live", "attach", { sigillum: "human-seal" });
    expect(f.call).toHaveBeenCalledWith({ operation: "attach", sigillum: "human-seal" },
      { url: "http://127.0.0.1:25001/", instanceId: "instance", clientId: "live", token: "d".repeat(43) });
    expect(authorizeOrbisRequest({ status: "blocked" }, "read")).toBeNull();
  });
  it("rejects missing/ended sessions and missing token before any discovery or operation", async () => {
    const f = fixture();
    await expect(f.service.execute("missing", "read", { sigillum: "s" })).rejects.toThrow("orbis_unauthorized");
    expect(authorizeOrbisRequest({ status: "ended" }, "read")).toBe("orbis_unauthorized");
    f.token.mockReturnValue(undefined);
    await expect(f.service.execute("live", "read", { sigillum: "s" })).rejects.toThrow("orbis_token_missing");
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
  });
  it("rechecks liveness after asynchronous discovery", async () => {
    const f = fixture();
    f.discover.mockImplementation(async () => { f.findSession.mockReturnValue(null); return { url: "http://127.0.0.1:25001/", instanceId: "instance" }; });
    await expect(f.service.execute("live", "read", { sigillum: "s" })).rejects.toThrow("orbis_unauthorized");
    expect(f.call).not.toHaveBeenCalled();
  });
  it("refuses reveal for arbitrary, AI and other-session IDs without a trusted ledger", async () => {
    const f = fixture();
    for (const userUtteranceId of ["arbitrary", "assistant:1", "other-session:1"]) {
      await expect(f.service.execute("live", "reveal", { sigillum: "s", userUtteranceId }))
        .rejects.toThrow("orbis_reveal_requires_user_utterance");
    }
    expect(f.token).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
  });
});
