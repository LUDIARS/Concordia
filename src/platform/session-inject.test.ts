import { describe, expect, it, vi } from "vitest";
import { ENTER_KEY_TEXT } from "./enter-key.js";
import { injectSession } from "./session-inject.js";

describe("injectSession", () => {
  it("posts the main inject and Codex Enter fallback through one policy", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("ok"));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const result = await injectSession({
      concordiaUrl: "http://127.0.0.1:11111/",
      sessionId: "session/1",
      text: "hello",
      source: "discord:1",
      authorLabel: "Human",
      enterFallbackSource: "discord-enter-fallback",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11111/v1/sessions/session%2F1/inject");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      text: "hello",
      source: "discord:1",
      author_label: "Human",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      text: ENTER_KEY_TEXT,
      source: "discord-enter-fallback",
    });
  });

  it("does not send the fallback after an HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(injectSession({
      concordiaUrl: "http://127.0.0.1:11111",
      sessionId: "s1",
      text: "hello",
      source: "slack:1",
      enterFallbackSource: "slack-enter-fallback",
      fetchImpl,
    })).resolves.toEqual({ ok: false, kind: "http", status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful main inject successful when the fallback transport fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok"))
      .mockRejectedValueOnce(new Error("offline")) as unknown as typeof fetch;
    await expect(injectSession({
      concordiaUrl: "http://127.0.0.1:11111",
      sessionId: "s1",
      text: "hello",
      source: "slack:1",
      enterFallbackSource: "slack-enter-fallback",
      fetchImpl,
    })).resolves.toEqual({ ok: true });
  });
});
