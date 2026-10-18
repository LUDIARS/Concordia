// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgePanel } from "./KnowledgePanel.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ""; });

const sources = [
  { kind: "ludiars", configured: true, last_attempt_at: 10, last_success_at: 10, last_error: null, running: false,
    counts: [{ doc_type: "readme", scope: "hq", docs: 2, chunks: 3 }, { doc_type: "readme", scope: "public", docs: 1, chunks: 1 }] },
  { kind: "revisor", configured: true, last_attempt_at: null, last_success_at: null, last_error: null, running: false, counts: [] },
  { kind: "notion", configured: false, last_attempt_at: 5, last_success_at: null, last_error: "not configured: notion token is not set", running: false, counts: [] },
];

async function mount(fetchImpl: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return fetchImpl(String(input), init);
  }));
  const el = document.createElement("div");
  document.body.appendChild(el);
  let root: Root;
  await act(async () => { root = createRoot(el); root.render(<KnowledgePanel />); });
  await act(async () => { await Promise.resolve(); });
  return { el, calls };
}

describe("KnowledgePanel", () => {
  it("shows counts per kind, last fetch and the failure reason", async () => {
    const { el } = await mount(() => new Response(JSON.stringify({ sources })));
    expect(el.querySelector("[data-testid=knowledge-ludiars]")?.textContent).toContain("3 文書 · 断片 本社限定 3 / 公開 1");
    const notion = el.querySelector("[data-testid=knowledge-notion]")?.textContent ?? "";
    expect(notion).toContain("未設定");
    expect(notion).toContain("notion token is not set");
  });

  it("shows each Notion map root with pages, excluded count, last fetch and failure", async () => {
    const notion_roots = [
      { root_id: "r1", title: "例の授業資料", pages: 12, excluded: 3, last_attempt_at: 10, last_success_at: 10, last_error: null, has_summary: true, pending_analyses: 2 },
      { root_id: "r2", title: null, pages: 0, excluded: 0, last_attempt_at: 10, last_success_at: null, last_error: "root page is not shared with the integration or was removed", has_summary: false, pending_analyses: 0 },
    ];
    const { el } = await mount(() => new Response(JSON.stringify({ sources, notion_roots })));
    const r1 = el.querySelector("[data-testid=notion-root-r1]")?.textContent ?? "";
    expect(r1).toContain("例の授業資料");
    expect(r1).toContain("12 ページ · 除外 3");
    expect(r1).toContain("解析待ち 2");
    expect(r1).toContain("まとめあり");
    const r2 = el.querySelector("[data-testid=notion-root-r2]")?.textContent ?? "";
    expect(r2).toContain("r2");
    expect(r2).toContain("not shared");
  });

  it("asks for a refresh of one kind", async () => {
    const { el, calls } = await mount((url) => url.endsWith("/refresh")
      ? new Response(JSON.stringify({ accepted: true, sources }), { status: 202 })
      : new Response(JSON.stringify({ sources })));
    const button = el.querySelector("[data-testid=knowledge-notion] button") as HTMLButtonElement;
    await act(async () => { button.click(); });
    expect(calls.find((c) => c.method === "POST")).toEqual({ url: "/v1/rules/knowledge/refresh", method: "POST", body: { kinds: ["notion"] } });
  });

  it("renders nothing when knowledge is not wired", async () => {
    const { el } = await mount(() => new Response(JSON.stringify({ error: "knowledge_unavailable" }), { status: 503 }));
    expect(el.querySelector("[data-testid=knowledge-panel]")).toBeNull();
  });
});
