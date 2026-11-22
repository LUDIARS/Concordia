// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseInstructions } from "./MuseInstructions.js";
import { historyUrl } from "./muse-instructions/history-api.js";

afterEach(() => { vi.unstubAllGlobals(); });

const record = {
  id: "inst:muse:20261123T000000Z:abcdef", agent: "muse", type: "run_task", title: "試遊して",
  status: "done", createdAt: "2026-11-23T00:00:00Z", ackedAt: "2026-11-23T00:01:00Z", finishedAt: "2026-11-23T00:02:00Z",
  resultSummary: "遊びました", body: "指令の本文", params: { build: 1 }, resultDetail: { score: 3 },
};

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<MuseInstructions />); });
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe("Muse 指令 page", () => {
  it("builds the history url with optional filters", () => {
    expect(historyUrl({ agent: "", status: "" })).toBe("/v1/instructions/history?limit=50");
    expect(historyUrl({ agent: "dots", status: "done" })).toBe("/v1/instructions/history?agent=dots&status=done&limit=50");
  });

  it("lists instructions with agent and result, opens a row for body and detail, and filters by agent", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { instructions: [record] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const { container, cleanup } = await render();
    try {
      expect(fetcher).toHaveBeenCalledWith("/v1/instructions/history?limit=50", expect.anything());
      const text = container.textContent ?? "";
      expect(text).toContain("試遊して");
      expect(text).toContain("muse");
      expect(text).toContain("完了");
      expect(text).toContain("遊びました");
      expect(text).not.toContain("指令の本文");

      const row = [...container.querySelectorAll("tbody tr")][0] as HTMLElement;
      await act(async () => { row.click(); });
      expect(container.textContent).toContain("指令の本文");
      expect(container.textContent).toContain("\"score\": 3");

      const select = container.querySelector("select[aria-label='宛先']") as HTMLSelectElement;
      await act(async () => {
        select.value = "dots";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(fetcher).toHaveBeenLastCalledWith("/v1/instructions/history?agent=dots&limit=50", expect.anything());
    } finally { await cleanup(); }
  });

  it("explains that the list is loopback only when the server answers 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "local_only", message: "x" } }), { status: 403 })));
    const { container, cleanup } = await render();
    try {
      expect(container.textContent).toContain("loopback");
    } finally { await cleanup(); }
  });
});
