// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UseCasesPanel } from "./UseCasesPanel.js";

afterEach(() => { vi.unstubAllGlobals(); });

const useCase = {
  id: "uc-qa", name: "技術相談", slug: "tech-qa", format: "qa", format_name: "一問一答 Q&A", summary: "質問に回答を返す。",
  work_mode: "read-only", pre_data: "- 結論を先に", use_requester_profile: true, archived: false, archived_at: null, updated_at: 1,
};

describe("use cases panel", () => {
  it("creates from a format and manages corrections of an opened use case", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
      const u = String(url);
      const method = options?.method ?? "GET";
      calls.push({ url: u, method, body: options?.body ? JSON.parse(String(options.body)) : null });
      if (u.startsWith("/v1/subsidiaries")) return new Response(JSON.stringify({ subsidiaries: [] }));
      if (u === "/v1/use-cases/formats") {
        return new Response(JSON.stringify({ formats: [{ key: "qa", name: "一問一答 Q&A", workMode: "read-only", useRequesterProfile: true, summary: "質問に回答", preData: "" }] }));
      }
      if (u.includes("/corrections") && method === "GET") {
        return new Response(JSON.stringify({ corrections: [{
          id: "c1", use_case_id: "uc-qa", subsidiary_id: null, department_id: null, session_id: null, source: "discord",
          question: "DDD の利点", correction: "用語を揃えられる", author: "1", active: 1, created_at: 1,
        }] }));
      }
      if (method === "POST") return new Response(JSON.stringify({ use_case: useCase, correction: {} }), { status: 201 });
      return new Response(JSON.stringify({ use_cases: [useCase] }));
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<UseCasesPanel />); });
      expect(container.textContent).toContain("技術相談");
      expect(container.textContent).toContain("読み取り専用");

      const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "技術相談")!;
      await act(async () => { open.click(); });
      expect(container.textContent).toContain("用語を揃えられる");

      const textarea = [...container.querySelectorAll("textarea")].find((t) => t.getAttribute("placeholder") === "正しい内容")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(textarea, "集約は小さく保つ");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const add = [...container.querySelectorAll("button")].find((b) => b.textContent === "訂正を追加")!;
      await act(async () => { add.click(); });
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/corrections"))?.body).toEqual({
        correction: "集約は小さく保つ", question: "", subsidiary_id: null,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
