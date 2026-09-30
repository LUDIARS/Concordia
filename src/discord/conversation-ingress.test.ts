import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationIngressPort, parseDecision } from "./conversation-ingress.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseDecision", () => {
  it("accepts the backend decisions", () => {
    expect(parseDecision({ action: "inject", sessionId: "s2", inputId: 3 })).toEqual({ action: "inject", sessionId: "s2", inputId: 3 });
    expect(parseDecision({ action: "held", reply: "保存しました" })).toEqual({ action: "held", reply: "保存しました" });
    expect(parseDecision({ action: "duplicate" })).toEqual({ action: "duplicate" });
  });

  it("falls back to the ordinary inject path on unreadable or error responses", () => {
    expect(parseDecision({ error: "down" })).toEqual({ action: "passthrough" });
    expect(parseDecision({ action: "inject" })).toEqual({ action: "passthrough" });
    expect(parseDecision({ action: "delete-everything" })).toEqual({ action: "passthrough" });
    expect(parseDecision(null)).toEqual({ action: "passthrough" });
  });
});

describe("createConversationIngressPort", () => {
  it("posts the Discord message to the backend conversation endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ action: "passthrough" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = createConversationIngressPort("http://127.0.0.1:1");
    await port.accept({
      guildId: "111111", threadId: "222222", messageId: "333333", authorId: "444444",
      authorLabel: "neco", text: "hi", boundSessionId: "s1", canControlSession: false,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:1/v1/delegation/sidecar/conversations/ingress");
    expect(JSON.parse(init.body)).toMatchObject({ platform: "discord", thread_id: "222222", can_control_session: false });
  });
});
