import { describe, expect, it, vi } from "vitest";
import { createRoutedNotionSource, notionRoutesFor } from "./notion-source-route.js";
import type { FetchedNotionPage, NotionPageSource } from "./notion-source-types.js";

const ID = "0123456789abcdef0123456789abcdef";
const PUBLIC = `https://example.notion.site/Example-${ID}`;
const limits = { pageTextBytes: 1000, maxChildren: 10 };

function page(via: "public" | "mcp"): FetchedNotionPage {
  return { id: ID, title: "t", url: null, lastEditedMs: null, text: "本文", children: [], links: [], via };
}

function sources(publicResult: FetchedNotionPage | null) {
  const pub: NotionPageSource = { fetchPage: vi.fn(async () => publicResult) };
  const mcp: NotionPageSource = { fetchPage: vi.fn(async () => page("mcp")) };
  return { pub, mcp, routed: createRoutedNotionSource({ public: pub, mcp }) };
}

describe("notion source routing", () => {
  it("prefers the public crawl when a public URL is known", async () => {
    expect(notionRoutesFor({ url: PUBLIC })).toEqual(["public", "mcp"]);
    const s = sources(page("public"));
    expect((await s.routed.fetchPage({ id: ID, url: PUBLIC }, limits))?.via).toBe("public");
    expect(s.mcp.fetchPage).not.toHaveBeenCalled();
  });

  it("falls back to MCP when the public crawl gets nothing", async () => {
    const s = sources(null);
    expect((await s.routed.fetchPage({ id: ID, url: PUBLIC }, limits))?.via).toBe("mcp");
  });

  it("uses MCP only when no public URL is known", async () => {
    expect(notionRoutesFor({ url: null })).toEqual(["mcp"]);
    expect(notionRoutesFor({ url: `https://www.notion.so/Example-${ID}` })).toEqual(["mcp"]);
    const s = sources(page("public"));
    expect((await s.routed.fetchPage({ id: ID, url: null }, limits))?.via).toBe("mcp");
    expect(s.pub.fetchPage).not.toHaveBeenCalled();
  });
});
