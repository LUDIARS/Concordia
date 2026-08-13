import { describe, expect, it, vi } from "vitest";
import { CatalogGeniusClient } from "./genius-client.js";

describe("CatalogGeniusClient", () => {
  it("applies the shared budget to catalog resolution and refuses redirects", async () => {
    const findService = vi.fn(async (_code: string, _timeoutMs?: number) => ({
      code: "genius",
      name: "Genius",
      port: 1234,
      state: "running",
      catalog_snapshot: { provides: { GENIUS_URL: "http://127.0.0.1:1234" } },
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return new Response(null, { status: 200 });
      return Response.json({ cards: [{ id: "card-1", situation: "task", score: 0.9 }] });
    });
    const client = new CatalogGeniusClient({ findService }, fetchMock as unknown as typeof fetch);

    await expect(client.query({ text: "task", k: 4 })).resolves.toHaveLength(1);

    expect(findService).toHaveBeenCalledWith("genius", expect.any(Number));
    const timeoutMs = findService.mock.calls[0]?.[1];
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(2_000);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("error");
    }
  });
});
