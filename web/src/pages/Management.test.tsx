// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Management } from "./Management.js";

afterEach(() => { vi.unstubAllGlobals(); });

const request = {
  id: "req-1", mission_name: "CDGD", request_key: "r1", kind: "spec_change", project_code: "KD", target_key: "variant/v1",
  purpose: "仕様を直す", completion_criteria: "Pf に反映", state: "waiting_human", session_id: null,
  outcome_summary: null, outcome_refs: [], error: null, actions: ["approve", "reject"],
};

describe("management page", () => {
  it("records a human approval with the entered actor", async () => {
    const fetcher = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).endsWith("/missions")
      ? { missions: [] } : String(url).endsWith("/requests") ? { requests: [request] } : { request })));
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<Management />); });
      expect(container.textContent).toContain("人間の判断待ち");
      const approve = [...container.querySelectorAll("button")].find((b) => b.textContent === "承認")!;
      expect(approve.disabled).toBe(true);
      const input = container.querySelector<HTMLInputElement>('input[aria-label="操作者名"]')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, "neco");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { approve.click(); });
      expect(fetcher).toHaveBeenCalledWith("/v1/admin/management/requests/req-1/approve",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ actor: "web:neco" }) }));
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
