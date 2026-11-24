import { describe, expect, it, vi } from "vitest";
import { ExcubitorClient } from "../excubitor/client.js";
import { CatalogGeniusClient } from "./genius-client.js";

describe("CatalogGeniusClient", () => {
  it("reads the topology from Excubitor and stops before sending task text if the endpoint is missing", async () => {
    const excubitorFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/api/v1/services/genius")) {
        return Response.json({ catalog_snapshot: { provides: { GENIUS_URL: "http://${host}:${port}" } } });
      }
      return Response.json({ env: {} });
    });
    const excubitor = new ExcubitorClient({ baseUrl: "http://excubitor.local", fetchImpl: excubitorFetch });
    const geniusFetch = vi.fn<typeof fetch>();
    const client = new CatalogGeniusClient(excubitor, geniusFetch);
    await expect(client.query({ text: "task", k: 4 })).resolves.toBeNull();
    expect(excubitorFetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://excubitor.local/api/v1/services/genius", "http://excubitor.local/api/v1/topology",
    ]);
    expect(geniusFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["http://127.0.0.1:1234", "http://127.0.0.1:1234"],
    ["http://${host}:${port}", "http://genius.site:4230"],
  ])("queries the catalog endpoint %s within the shared budget and refuses redirects", async (declared, endpoint) => {
    const findService = vi.fn(async (_code: string, _timeoutMs?: number) => ({
      code: "genius",
      name: "Genius",
      port: 1234,
      state: "running",
      catalog_snapshot: { provides: { GENIUS_URL: declared } },
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return new Response(null, { status: 200 });
      return Response.json({ cards: [{ id: "card-1", situation: "task", score: 0.9 }] });
    });
    const topologyValue = vi.fn(async () => endpoint);
    const client = new CatalogGeniusClient({ findService, topologyValue }, fetchMock as unknown as typeof fetch);

    await expect(client.query({ text: "task", k: 4 })).resolves.toHaveLength(1);

    expect(findService).toHaveBeenCalledWith("genius", expect.any(Number));
    const timeoutMs = findService.mock.calls[0]?.[1];
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(2_000);
    if (declared === endpoint) expect(topologyValue).not.toHaveBeenCalled();
    else expect(topologyValue).toHaveBeenCalledWith("GENIUS_URL", expect.any(Number));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      endpoint + "/healthz", endpoint + "/api/clone/query",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("error");
    }
  });
});
