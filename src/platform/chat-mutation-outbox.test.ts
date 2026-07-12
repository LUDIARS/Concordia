import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ChatMutationOutboxRepo } from "../db/chat-mutation-outbox-repo.js";
import { installChatMutationOutbox } from "./chat-mutation-outbox.js";

describe("chat mutation outbox", () => {
  it("queues a core mutation when the backend transport is unavailable", async () => {
    const repo = new ChatMutationOutboxRepo(makeTestDb());
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const handle = installChatMutationOutbox({
      baseUrl: "http://127.0.0.1:11111",
      repo,
      fetchImpl,
      retryMs: 1_000_000,
    });
    try {
      const response = await fetch("http://127.0.0.1:11111/v1/sessions/s1/inject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "continue" }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ queued: true });
      expect(repo.list()).toMatchObject([
        { method: "POST", path: "/v1/sessions/s1/inject", body_json: '{"text":"continue"}' },
      ]);
    } finally {
      handle.stop();
    }
  });

  it("does not intercept external platform requests", async () => {
    const repo = new ChatMutationOutboxRepo(makeTestDb());
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    const handle = installChatMutationOutbox({
      baseUrl: "http://127.0.0.1:11111",
      repo,
      fetchImpl,
      retryMs: 1_000_000,
    });
    try {
      const response = await fetch("https://discord.com/api/test", { method: "POST" });
      expect(response.ok).toBe(true);
      expect(repo.list()).toEqual([]);
    } finally {
      handle.stop();
    }
  });

  it("does not undo a fetch wrapper installed after the outbox", () => {
    const repo = new ChatMutationOutboxRepo(makeTestDb());
    const originalFetch = globalThis.fetch;
    const handle = installChatMutationOutbox({
      baseUrl: "http://127.0.0.1:11111",
      repo,
      retryMs: 1_000_000,
    });
    const newerFetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    globalThis.fetch = newerFetch;
    try {
      handle.stop();
      expect(globalThis.fetch).toBe(newerFetch);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
