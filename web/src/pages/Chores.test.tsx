// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chores } from "./Chores.js";
afterEach(() => { vi.unstubAllGlobals(); });
describe("chores page", () => {
  it("shows saved output and sends Continue for that run", async () => {
    const run = { id: "run-1", prompt: "依頼", provider: "claude", status: "succeeded", cwd: "/chores/run-1", output: "結果全文", error: null, spawn_id: null };
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => new Response(JSON.stringify(options?.method === "POST"
      ? { run: { ...run, status: "continued", spawn_id: "spawn-1" } } : { runs: [run] })));
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Chores />); });
      expect(container.textContent).toContain("結果全文");
      const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Continue")!;
      await act(async () => { button.click(); });
      expect(fetcher).toHaveBeenCalledWith("/v1/chores/run-1/choice", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "continue" }) }));
      expect(container.textContent).toContain("継続セッション起動済み");
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
