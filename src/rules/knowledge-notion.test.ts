import { describe, expect, it, vi } from "vitest";
import { NOTION_MIN_INTERVAL_MS, createNotionCollector, nextDelayMs } from "./knowledge-notion.js";
import type { KnowledgeCollection } from "./knowledge-types.js";

// 実 Notion は呼ばない。 fetch を差し替え、 要求の時刻・本文を記録する。

const TOKEN = "secret-example-token-0000";

function page(id: string, edited: string, title = `page ${id}`) {
  return {
    object: "page", id, url: `https://www.notion.so/example-${id}`, last_edited_time: edited,
    properties: { Name: { type: "title", title: [{ plain_text: title }] } },
  };
}

function para(text: string, extra: Record<string, unknown> = {}) {
  return { object: "block", id: `b-${text}`, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: text }] }, ...extra };
}

function harness(routes: (url: string, body: unknown) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const clock = { ms: 1_000_000 };
  const calls: Array<{ url: string; at: number; body: unknown; headers: Record<string, string> }> = [];
  const sleep = vi.fn(async (ms: number) => { clock.ms += ms; });
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, at: clock.ms, body, headers: init.headers as Record<string, string> });
    const r = routes(url, body);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  });
  const collector = createNotionCollector({ token: () => TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: () => clock.ms, sleep });
  return { collector, calls, sleep, clock };
}

describe("nextDelayMs (chat-knowledge-C-5)", () => {
  it("waits so requests are at least the minimum interval apart", () => {
    expect(nextDelayMs(null, 10, 334)).toBe(0);
    expect(nextDelayMs(1000, 1100, 334)).toBe(234);
    expect(nextDelayMs(1000, 2000, 334)).toBe(0);
  });
});

describe("createNotionCollector", () => {
  it("stops when the token is not set", async () => {
    const collector = createNotionCollector({ token: () => null, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(await collector({ cursor: null, full: false })).toEqual({ notConfigured: "notion token is not set" });
  });

  it("reads shared pages and their text as hq documents, respecting 3 req/s", async () => {
    const h = harness((url) => url.endsWith("/search")
      ? { json: { results: [page("p2", "2026-10-02T00:00:00.000Z"), page("p1", "2026-10-01T00:00:00.000Z")], has_more: false } }
      : { json: { results: [para(`text of ${url.includes("p1") ? "p1" : "p2"}`)], has_more: false } });
    const out = await h.collector({ cursor: null, full: false }) as KnowledgeCollection;
    expect(out.full).toBe(true);
    expect(out.docs.map((d) => [d.docKey, d.scope, d.text])).toEqual([
      ["notion:p2", "hq", "text of p2"],
      ["notion:p1", "hq", "text of p1"],
    ]);
    expect(out.cursor).toBe("2026-10-02T00:00:00.000Z");
    for (let i = 1; i < h.calls.length; i += 1) {
      expect(h.calls[i]!.at - h.calls[i - 1]!.at).toBeGreaterThanOrEqual(NOTION_MIN_INTERVAL_MS);
    }
    expect(h.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.calls[0]!.headers["notion-version"]).toBeTruthy();
  });

  it("only reads pages edited after the cursor (incremental)", async () => {
    const h = harness((url) => url.endsWith("/search")
      ? { json: { results: [page("new", "2026-10-03T00:00:00.000Z"), page("old", "2026-09-01T00:00:00.000Z")], has_more: true, next_cursor: "c2" } }
      : { json: { results: [para("body")], has_more: false } });
    const out = await h.collector({ cursor: "2026-10-01T00:00:00.000Z", full: false }) as KnowledgeCollection;
    expect(out.full).toBe(false);
    expect(out.docs.map((d) => d.docKey)).toEqual(["notion:new"]);
    // 起点より古いページに届いたので、 次の search のページは読まない
    expect(h.calls.filter((c) => c.url.endsWith("/search"))).toHaveLength(1);
    expect(h.calls.some((c) => c.url.includes("/blocks/old/"))).toBe(false);
  });

  it("waits Retry-After once on 429, then fails without leaking the token", async () => {
    let n = 0;
    const h = harness(() => (n++ === 0 ? { status: 429, headers: { "retry-after": "2" } } : { status: 429 }));
    await expect(h.collector({ cursor: null, full: true })).rejects.toThrow(/rate limited/);
    expect(h.sleep).toHaveBeenCalledWith(2000);
    try {
      await h.collector({ cursor: null, full: true });
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it("reports an auth failure by status only", async () => {
    const h = harness(() => ({ status: 401 }));
    await expect(h.collector({ cursor: null, full: true })).rejects.toThrow("notion rejected the token (http 401)");
  });
});
