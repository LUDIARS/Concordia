import { expect, it } from "vitest";
import { escapeHtml, renderKnowledgeHtml } from "./html-report.js";

it("値をエスケープし、http(s) 以外の URL はリンクにしない", () => {
  const html = renderKnowledgeHtml({
    query: "<script>alert(1)</script>",
    requestId: 7,
    createdAt: new Date("2026-11-28T00:00:00Z"),
    answer: {
      summary: "要約 & 補足",
      roles: [{ role: "プログラマ", skills: ["C++ <17>"], technical: ["Vulkan"] }],
      sources: [
        { title: "安全", url: "https://example.org/a?x=1&y=2", source: "notion", tags: ["vulkan"] },
        { title: "危険", url: "javascript:alert(1)", source: "ludiars", tags: [] },
      ],
    },
  });
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("要約 &amp; 補足");
  expect(html).toContain("C++ &lt;17&gt;");
  expect(html).toContain('href="https://example.org/a?x=1&amp;y=2"');
  expect(html).not.toContain("javascript:");
  expect(html).toContain("Notion");
  expect(html).toContain("検索 #7");
});

it("escapeHtml は引用符も変える", () => {
  expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
});
