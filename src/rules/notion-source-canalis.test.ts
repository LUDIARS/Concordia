import { describe, expect, it, vi } from "vitest";
import { canalisPageFingerprint, canalisPageUrl, createCanalisNotionSource, type CanalisPageFetcher } from "./notion-source-canalis.js";

const ID = "0123456789abcdef0123456789abcdef";
const CHILD = "abcdef0123456789abcdef0123456789";
const limits = { pageTextBytes: 20, maxChildren: 10 };

function reader(markdown = "prefix".repeat(100) + "tail") {
  const fetcher: CanalisPageFetcher = {
    fetch: vi.fn(async (url) => ({ url, title: "Lesson", markdown, raw: {
      links: [`https://example.notion.site/${CHILD}`, "https://example.com/private"],
    } })),
    close: vi.fn(async () => undefined),
  };
  return { fetcher, source: createCanalisNotionSource({ createFetcher: async () => fetcher }) };
}

describe("Canalis before paid Notion retrieval (CC-NOTION-FULLTEXT-01)", () => {
  it("reads IDs without a public URL, clips only after fingerprinting, and keeps Notion children", async () => {
    const h = reader();
    const page = await h.source.fetchPage({ id: ID, url: null }, limits);
    expect(h.fetcher.fetch).toHaveBeenCalledWith(`https://www.notion.so/${ID}`, expect.any(Object));
    expect(Buffer.byteLength(page!.text)).toBe(20);
    expect(page!.contentFingerprint).toMatch(/^canalis-v1:[a-f0-9]{64}$/);
    expect(page!.children.map((p) => p.id)).toEqual([CHILD]);
    await h.source.close?.();
    expect(h.fetcher.close).toHaveBeenCalledOnce();
  });

  it("detects a tail edit beyond the stored excerpt", () => {
    const prefix = "x".repeat(10_000);
    expect(canalisPageFingerprint("t", prefix + "a", []))
      .not.toBe(canalisPageFingerprint("t", prefix + "b", []));
  });

  it("detects title/link edits while ignoring link ordering and CRLF differences", () => {
    const a = canalisPageFingerprint("t", "a\r\nb", ["2", "1"]);
    expect(a).toBe(canalisPageFingerprint("t", "a\nb", ["1", "2", "1"]));
    expect(a).not.toBe(canalisPageFingerprint("new", "a\nb", ["1", "2"]));
    expect(a).not.toBe(canalisPageFingerprint("t", "a\nb", ["1", "3"]));
  });

  it("does not treat empty/failed rendering as unchanged or call an AI fallback", async () => {
    const h = reader(" ");
    await expect(h.source.fetchPage({ id: ID, url: null }, limits)).rejects.toThrow(/could not read/);
    expect(h.source.preserveRootOnFailure).toBe(true);
    await h.source.close?.();
    expect(h.fetcher.close).toHaveBeenCalledOnce();
  });

  it("rejects credentials, a different page, non-Notion hosts and non-HTTPS URLs", () => {
    for (const url of [`http://www.notion.so/${ID}`, `https://notion.so.evil.test/${ID}`,
      `https://user:pass@www.notion.so/${ID}`, `https://www.notion.so/${CHILD}`]) {
      expect(() => canalisPageUrl({ id: ID, url })).toThrow();
    }
  });

  it("does not call paid retrieval for readable content, but reports capability fallback", async () => {
    const h = reader();
    const fallback = { fetchPage: vi.fn(async () => null) };
    const log = { warn: vi.fn() };
    const source = createCanalisNotionSource({ createFetcher: async () => h.fetcher, fallback, log });
    await source.fetchPage({ id: ID, url: null }, limits);
    expect(fallback.fetchPage).not.toHaveBeenCalled();
    vi.mocked(h.fetcher.fetch).mockRejectedValueOnce(new Error("Notion requires login"));
    expect(await source.fetchPage({ id: ID, url: null }, limits)).toBeNull();
    expect(fallback.fetchPage).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    await source.close?.();
  });

  it("does not hide missing Chromium by using paid retrieval", async () => {
    const h = reader();
    vi.mocked(h.fetcher.fetch).mockRejectedValueOnce(new Error("browserType.launch: Executable doesn't exist"));
    const fallback = { fetchPage: vi.fn(async () => null) };
    const source = createCanalisNotionSource({ createFetcher: async () => h.fetcher, fallback });
    await expect(source.fetchPage({ id: ID, url: null }, limits)).rejects.toThrow(/setup failed/);
    expect(fallback.fetchPage).not.toHaveBeenCalled();
    await source.close?.();
  });
});
