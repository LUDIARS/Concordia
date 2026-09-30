// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Departments } from "./Departments.js";

afterEach(() => { vi.unstubAllGlobals(); });

const department = {
  id: "dept-qa", subsidiary_id: null, name: "技術相談課", slug: "qa", description: "",
  settings: {
    launch: { provider: "claude" }, projects: [],
    output: { thinking: "off", status_card: "inherit", session_info_card: "inherit", cost_report: "inherit" },
  },
  settings_error: null, rules_text: "", sort_order: 0, use_case_id: "uc-qa", is_default: false,
  discord_forum_id: "forum-qa", archived: false, archived_at: null,
};

function stubFetch() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetcher = vi.fn(async (url: unknown, options?: RequestInit) => {
    const u = String(url);
    const method = options?.method ?? "GET";
    calls.push({ url: u, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    if (u.startsWith("/v1/subsidiaries")) return new Response(JSON.stringify({ subsidiaries: [] }));
    if (u.startsWith("/v1/use-cases")) {
      return new Response(JSON.stringify({ use_cases: [{ id: "uc-qa", name: "技術相談", format_name: "一問一答 Q&A" }] }));
    }
    if (method === "PATCH") return new Response(JSON.stringify({ department: { ...department, name: "技術相談室" } }));
    if (method === "POST") return new Response(JSON.stringify({ department: { ...department, id: "dept-new" } }), { status: 201 });
    return new Response(JSON.stringify({ departments: [department] }));
  });
  vi.stubGlobal("fetch", fetcher);
  return calls;
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Departments />); });
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe("departments page", () => {
  it("lists head-office departments with their use case", async () => {
    const calls = stubFetch();
    const { container, cleanup } = await render();
    try {
      expect(calls.some((call) => call.url === "/v1/departments?include_archived=1")).toBe(true);
      expect(container.textContent).toContain("技術相談課");
      expect(container.textContent).toContain("ユースケース: 技術相談");
    } finally { await cleanup(); }
  });

  it("saves the edited department with its settings and output policy", async () => {
    const calls = stubFetch();
    const { container, cleanup } = await render();
    try {
      const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "技術相談課")!;
      await act(async () => { open.click(); });
      const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "保存")!;
      await act(async () => { save.click(); });
      const patch = calls.find((call) => call.method === "PATCH");
      expect(patch?.url).toBe("/v1/departments/dept-qa");
      expect(patch?.body).toMatchObject({
        use_case_id: "uc-qa",
        is_default: false,
        settings: { launch: { provider: "claude" }, projects: [], output: { thinking: "off" } },
      });
      expect(container.textContent).toContain("保存しました");
    } finally { await cleanup(); }
  });

  it("saves the private consultation setting of a department", async () => {
    const calls = stubFetch();
    const { container, cleanup } = await render();
    try {
      const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "技術相談課")!;
      await act(async () => { open.click(); });
      const toggle = [...container.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("/consult"))!
        .querySelector("input") as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      await act(async () => { toggle.click(); });
      const role = [...container.querySelectorAll("select")]
        .find((select) => [...select.options].some((option) => option.value === "executive")) as HTMLSelectElement;
      await act(async () => {
        role.value = "executive";
        role.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "保存")!;
      await act(async () => { save.click(); });
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
        settings: { private: { enabled: true, approver_min_role: "executive" } },
      });
    } finally { await cleanup(); }
  });

  it("creates a department in the selected organization", async () => {
    const calls = stubFetch();
    const { container, cleanup } = await render();
    try {
      const [nameInput, slugInput] = [...container.querySelectorAll("input")] as HTMLInputElement[];
      const setValue = (input: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => { setValue(nameInput!, "運用部"); setValue(slugInput!, "ops"); });
      const create = [...container.querySelectorAll("button")].find((b) => b.textContent === "作成")!;
      await act(async () => { create.click(); });
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({ name: "運用部", slug: "ops", subsidiary_id: null });
    } finally { await cleanup(); }
  });
});
