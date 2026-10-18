import { describe, expect, it, vi } from "vitest";
import { createRateGate } from "./knowledge-notion.js";
import { createPublicNotionSource, extractPublicNotionPage, isBotChallengeTitle, isPublicNotionUrl } from "./notion-source-public.js";

// 実 Notion は呼ばない。 架空の公開ページの HTML を fetch に差し替える。

const ID = "0123456789abcdef0123456789abcdef";
const CHILD = "1123456789abcdef0123456789abcdef";
const PAGE_URL = `https://example.notion.site/Example-${ID}`;

const html = `<!doctype html><html><head><title>例の授業資料 | Notion</title><style>.x{}</style></head><body>
<nav><a href="/Nav-2223456789abcdef0123456789abcdef">ナビ</a></nav>
<div class="notion-page-content">
  <div data-block-id="a"><h2>第1回 &amp; 準備</h2></div>
  <div data-block-id="b"><p>ゲームループの基本</p></div>
  <script>window.secret = 1</script>
  <a href="/Lesson-${CHILD}">第1回</a>
  <a href="${PAGE_URL}">自分</a>
  <a href="https://other.example.test/Out-3123456789abcdef0123456789abcdef">外部</a>
  <a href="/no-id">ID なし</a>
</div></body></html>`;

describe("public Notion crawl", () => {
  it("recognizes public page URLs", () => {
    expect(isPublicNotionUrl(PAGE_URL)).toBe(true);
    expect(isPublicNotionUrl(`https://www.notion.so/Example-${ID}`)).toBe(false);
    expect(isPublicNotionUrl("http://example.notion.site/x")).toBe(false);
    expect(isPublicNotionUrl(null)).toBe(false);
    expect(isBotChallengeTitle("Just a moment...")).toBe(true);
  });

  it("extracts the title, the page content text and same-origin child page links", () => {
    const ex = extractPublicNotionPage(html, PAGE_URL);
    expect(ex.title).toBe("例の授業資料");
    expect(ex.text).toContain("第1回 & 準備");
    expect(ex.text).toContain("ゲームループの基本");
    expect(ex.text).not.toContain("secret");
    expect(ex.text).not.toContain("ナビ");
    expect(ex.links).toEqual([`https://example.notion.site/Lesson-${CHILD}`]);
  });

  it("fetches a public page as a source, with children from links", async () => {
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const gate = createRateGate({ sleep: async () => undefined });
    const source = createPublicNotionSource({ fetchImpl: fetchImpl as unknown as typeof fetch, gate });
    const page = await source.fetchPage({ id: ID, url: PAGE_URL }, { pageTextBytes: 1000, maxChildren: 10 });
    expect(page).toMatchObject({ id: ID, title: "例の授業資料", via: "public", lastEditedMs: null });
    expect(page!.children).toEqual([{ id: CHILD, url: `https://example.notion.site/Lesson-${CHILD}`, title: null }]);
  });

  it("returns null (so MCP is tried) for non-public URLs, errors, empty or challenge pages", async () => {
    const gate = createRateGate({ sleep: async () => undefined });
    const limits = { pageTextBytes: 1000, maxChildren: 10 };
    const never = vi.fn();
    expect(await createPublicNotionSource({ fetchImpl: never as unknown as typeof fetch, gate }).fetchPage({ id: ID, url: null }, limits)).toBeNull();
    expect(never).not.toHaveBeenCalled();
    const status = vi.fn(async () => new Response("", { status: 404 }));
    expect(await createPublicNotionSource({ fetchImpl: status as unknown as typeof fetch, gate }).fetchPage({ id: ID, url: PAGE_URL }, limits)).toBeNull();
    const empty = vi.fn(async () => new Response("<html><head><title>x</title></head><body><div class=\"notion-page-content\"></div></body></html>"));
    expect(await createPublicNotionSource({ fetchImpl: empty as unknown as typeof fetch, gate }).fetchPage({ id: ID, url: PAGE_URL }, limits)).toBeNull();
    const challenge = vi.fn(async () => new Response("<html><head><title>Just a moment...</title></head><body>wait</body></html>"));
    expect(await createPublicNotionSource({ fetchImpl: challenge as unknown as typeof fetch, gate }).fetchPage({ id: ID, url: PAGE_URL }, limits)).toBeNull();
  });
});
