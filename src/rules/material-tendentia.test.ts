import { describe, expect, it, vi } from "vitest";
import { MaterialSourceError } from "./material-types.js";
import { TENDENTIA_SOURCE_ID, makeTendentiaSource, normalizeTendentiaOverview } from "./material-tendentia.js";

const OBSERVED = "2026-10-15T12:00:00.000Z";

function overview() {
  return {
    busy: true,
    overview: {
      lastCrawledAt: "2026-10-15T11:00:00.000Z",
      crossHits: [],
      genres: [
        {
          genre: "tech",
          label: "IT",
          highlights: [],
          sources: [
            {
              sourceId: "hn",
              name: "Hacker News",
              fetchedAt: "2026-10-15T11:00:00.000Z",
              error: null,
              items: [
                { key: "k1", title: "New compiler", subtitle: "fast", url: "https://example.com/1", metric: "300 points", rank: 1, firstSeenAt: "2026-10-15T10:00:00.000Z" },
                { key: "k2", title: "", url: null },
              ],
            },
            { sourceId: "broken", name: "Broken", fetchedAt: "2026-10-14T00:00:00.000Z", error: "HTTP 500", items: [{ key: "x", title: "stale" }] },
            { sourceId: "never", name: "Never", fetchedAt: null, error: null, items: [{ key: "y", title: "no fetch" }] },
          ],
        },
      ],
    },
  };
}

describe("normalizeTendentiaOverview", () => {
  it("normalizes public ranking items with identity and fetch version", () => {
    const items = normalizeTendentiaOverview(overview(), OBSERVED);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: TENDENTIA_SOURCE_ID,
      itemId: "hn:k1",
      version: "hn:k1:2026-10-15T11:00:00.000Z",
      kind: "trend",
      featureKey: "tech",
      occurredAt: "2026-10-15T10:00:00.000Z",
      url: "https://example.com/1",
      shareableTo: ["*"],
    });
    expect(items[0].excerpt).toContain("Hacker News");
  });

  it("skips sources with an error or without a fetch time (stale success data)", () => {
    const ids = normalizeTendentiaOverview(overview(), OBSERVED).map((m) => m.itemId);
    expect(ids).not.toContain("broken:x");
    expect(ids).not.toContain("never:y");
  });

  it("rejects a body without genres as a schema error, not an empty list", () => {
    expect(() => normalizeTendentiaOverview({ busy: false }, OBSERVED)).toThrow(MaterialSourceError);
  });
});

describe("makeTendentiaSource", () => {
  const query = { since: "2026-10-14T00:00:00.000Z", limit: 100, scopeKey: "hq" };

  it("is not-configured without a base URL", async () => {
    await expect(makeTendentiaSource({ baseUrl: null }).list(query)).rejects.toMatchObject({ code: "not-configured" });
  });

  it("reads only the overview endpoint and never triggers a crawl", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(overview()), { status: 200 }));
    const source = makeTendentiaSource({ baseUrl: "http://127.0.0.1:9/", fetch: fetchMock as unknown as typeof fetch, now: () => new Date(OBSERVED) });
    const page = await source.list(query);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://127.0.0.1:9/api/trend-crawler/overview");
    expect(page.status).toBe("ready");
    expect(page.items.map((m) => m.itemId)).toEqual(["hn:k1"]);
  });

  it("keeps later genres within the item cap and filters genres before capping", async () => {
    // 総合ジャンルが先頭で 150 件ある overview。 先頭から切るとゲーム・技術が候補に入らなかった (2026-10-15)。
    const many = (genre: string, n: number) => ({
      genre, label: genre, highlights: [],
      sources: [{
        sourceId: `${genre}-src`, name: genre, fetchedAt: "2026-10-15T11:00:00.000Z", error: null,
        items: Array.from({ length: n }, (_, i) => ({ key: `${genre}${i}`, title: `${genre} ${i}`, firstSeenAt: "2026-10-15T10:00:00.000Z" })),
      }],
    });
    const body = { overview: { genres: [many("general", 150), many("game", 5), many("tech", 5)] } };
    const source = makeTendentiaSource({ baseUrl: "http://x", fetch: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch });
    const all = await source.list(query);
    expect(all.items).toHaveLength(100);
    expect(all.items.filter((m) => m.featureKey === "game")).toHaveLength(5);
    expect(all.items.filter((m) => m.featureKey === "tech")).toHaveLength(5);
    const onlyGame = await source.list({ ...query, genres: ["game"] });
    expect(onlyGame.items.map((m) => m.featureKey)).toEqual(Array(5).fill("game"));
  });

  it("maps auth and HTTP failures to explicit errors", async () => {
    const auth = makeTendentiaSource({ baseUrl: "http://x", fetch: (async () => new Response("", { status: 403 })) as unknown as typeof fetch });
    await expect(auth.list(query)).rejects.toMatchObject({ code: "auth" });
    const down = makeTendentiaSource({ baseUrl: "http://x", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    await expect(down.list(query)).rejects.toMatchObject({ code: "unavailable" });
  });
});
