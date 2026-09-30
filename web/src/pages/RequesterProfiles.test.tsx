// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequesterProfiles } from "./RequesterProfiles.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("requester profiles page", () => {
  it("shows a requester's notes and saves edits for the same identity", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const profile = {
      id: "rp-1", subsidiary_id: null, platform: "discord", platform_user_id: "123456", display_name: "neco",
      skill_level: "中級", activities: "Unity のゲーム開発", notes: "", updated_at: 1,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      calls.push({ url: String(url), method, body: options?.body ? JSON.parse(String(options.body)) : null });
      if (String(url).startsWith("/v1/subsidiaries")) return new Response(JSON.stringify({ subsidiaries: [] }));
      if (method === "PUT") return new Response(JSON.stringify({ profile }));
      return new Response(JSON.stringify({ profiles: [profile] }));
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<RequesterProfiles />); });
      expect(container.textContent).toContain("123456");
      expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Unity のゲーム開発");
      const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "保存")!;
      await act(async () => { save.click(); });
      expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({
        subsidiary_id: null, platform: "discord", platform_user_id: "123456", skill_level: "中級",
      });
      expect(container.textContent).toContain("保存しました");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
