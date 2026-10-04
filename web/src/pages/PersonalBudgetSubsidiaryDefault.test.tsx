// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubsidiariesSection } from "./subsidiaries/SubsidiariesSection.js";

afterEach(() => { vi.unstubAllGlobals(); });

const LABEL = "個人の月間トークン予算の既定値 (0 = 上限なし)";

describe("subsidiary settings: personal monthly token budget", () => {
  it("sends the per-person monthly default when a subsidiary is created", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, options?: RequestInit) => {
      const url = String(input);
      const method = options?.method ?? "GET";
      calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null });
      if (url.startsWith("/v1/project-codes")) return new Response(JSON.stringify({ source: "concordia-db", categories: [] }));
      if (url.startsWith("/v1/delegation/templates")) return new Response(JSON.stringify({ templates: [] }));
      if (method === "POST") return new Response(JSON.stringify({ subsidiary: { id: "sub-1" } }));
      return new Response(JSON.stringify({ subsidiaries: [] }));
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<SubsidiariesSection />); });
      const label = [...container.querySelectorAll("label")].find((el) => el.textContent?.includes(LABEL));
      expect(label).toBeDefined();
      const input = label!.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("0");

      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, "500000");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const create = [...container.querySelectorAll("button")].find((b) => b.textContent === "作成")!;
      await act(async () => { create.click(); });

      const posted = calls.find((call) => call.method === "POST" && call.url === "/v1/subsidiaries");
      expect(posted?.body).toMatchObject({ personal_monthly_token_budget: 500_000, daily_token_budget: 0 });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
