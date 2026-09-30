// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../../api.js";
import { OrganizationsSection } from "./OrganizationsSection.js";

afterEach(() => { vi.unstubAllGlobals(); });

function session(id: string, departmentId: string | null): SessionRow {
  return {
    id, provider: "claude-code", repo_path: "E:/work", repo_origin: null, branch: "main", host: "h",
    started_at: 1, ended_at: null, status: "active", last_seen_at: 1, current_task: null, metadata: {},
    department_id: departmentId,
  } as unknown as SessionRow;
}

describe("organizations section", () => {
  it("splits the head-office card into department sections", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("/v1/departments")) {
        return new Response(JSON.stringify({ departments: [
          { id: "general", subsidiary_id: null, name: "総務", slug: "general", sort_order: 0, archived: false, is_default: true, settings: null },
          { id: "qa", subsidiary_id: null, name: "技術相談課", slug: "qa", sort_order: 1, archived: false, is_default: false, settings: null },
        ] }));
      }
      if (u.startsWith("/v1/subsidiaries")) return new Response(JSON.stringify({ subsidiaries: [] }));
      if (u.startsWith("/v1/delegation/templates")) return new Response(JSON.stringify({ templates: [] }));
      if (u.startsWith("/v1/work/repos")) return new Response(JSON.stringify({ repos: [] }));
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <OrganizationsSection active={[session("s-general", "general"), session("s-qa", "qa"), session("s-none", null)]} />
          </MemoryRouter>,
        );
      });
      const text = container.textContent ?? "";
      expect(text).toContain("総務");
      expect(text).toContain("既定");
      expect(text).toContain("技術相談課");
      expect(text).toContain("未配属");
      expect(text.indexOf("総務")).toBeLessThan(text.indexOf("技術相談課"));
      expect(text.indexOf("技術相談課")).toBeLessThan(text.indexOf("未配属"));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
