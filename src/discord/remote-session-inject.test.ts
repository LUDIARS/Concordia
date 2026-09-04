import { describe, expect, it, vi } from "vitest";
import { createRemoteSessionInject } from "./remote-session-inject.js";

describe("createRemoteSessionInject", () => {
  it("encodes the session id and forwards provenance to the backend", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }));
    const warn = vi.fn();
    const emit = createRemoteSessionInject("http://concordia.test", { warn }, fetchImpl);
    const provenance = {
      kind: "reaction-workflow" as const,
      action: "start-impl",
      platform: "discord" as const,
      emoji: "👍",
      sourceMessageId: "message-1",
      actorId: "user-1",
    };

    emit("session/one", "start", "reaction-workflow", provenance);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    expect(fetchImpl.mock.calls[0][0]).toBe("http://concordia.test/v1/sessions/session%2Fone/inject");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      text: "start",
      source: "reaction-workflow",
      provenance,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
