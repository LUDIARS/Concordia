// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Department } from "../api.js";
import { DelegationSpawnForm } from "./DelegationSpawnForm.js";

afterEach(() => { vi.unstubAllGlobals(); });

const department: Department = {
  id: "dept-ops", subsidiary_id: null, name: "運用部", slug: "ops", description: "",
  settings: {
    launch: { provider: "codex", project: "infra" }, projects: ["infra"],
    output: { thinking: "inherit", status_card: "inherit", session_info_card: "inherit", cost_report: "inherit" },
  },
  settings_error: null, rules_text: "", sort_order: 0, use_case_id: null, is_default: false,
  discord_forum_id: null, archived: false, archived_at: null,
};

describe("DelegationSpawnForm with a department", () => {
  it("prefills the department defaults and launches as that department", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === "POST") bodies.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ ok: true, pid: 1 }));
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<DelegationSpawnForm department={department} templates={[]} projects={["infra"]} />);
      });
      expect(container.textContent).toContain("部署「運用部」として起動します");
      const form = container.querySelector("form")!;
      await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      expect(bodies[0]).toMatchObject({ department: "dept-ops", provider: "codex", project: "infra" });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
