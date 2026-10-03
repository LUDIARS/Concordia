// @vitest-environment jsdom
/** @implements spec/feature/usage-budgets.md §9 — 子会社ごとの同時セッション上限を設定画面で決める */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubsidiariesSection } from "./SubsidiariesSection.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("SubsidiariesSection session cap", () => {
  it("sends the session cap entered in the form when creating a subsidiary (0 = no cap by default)", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
      const path = String(url);
      if ((options?.method ?? "GET") === "POST" && path === "/v1/subsidiaries") {
        posts.push(JSON.parse(String(options?.body)));
        return new Response(JSON.stringify({ subsidiary: {} }));
      }
      if (path.startsWith("/v1/delegation/templates")) return new Response(JSON.stringify({ templates: [] }));
      return new Response(JSON.stringify({ subsidiaries: [] }));
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<SubsidiariesSection />); });
      const label = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes("同時セッション上限"))!;
      const input = label.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("0");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(input, "12");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const create = [...container.querySelectorAll("button")].find((b) => b.textContent === "作成")!;
      await act(async () => { create.click(); });
      expect(posts).toHaveLength(1);
      expect((posts[0] as { max_sessions?: number }).max_sessions).toBe(12);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
