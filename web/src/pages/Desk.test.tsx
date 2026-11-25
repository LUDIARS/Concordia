// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "./Desk.js";
import { Chores } from "./Chores.js";

// Control also imports DeskDetail. Reload the shared module with this suite's chat mock.
vi.hoisted(() => vi.resetModules());
vi.mock("./session-chat/SessionChat.js", () => ({
  SessionChat: ({ deskSessionId }: { deskSessionId: string }) => <textarea aria-label={`chat-${deskSessionId}`} />,
}));

afterEach(() => { vi.unstubAllGlobals(); });

const running = {
  id: "req-1", request_key: "web:abcdefgh-1", origin: "web", requester: "web", provider: "claude", body: "README を直して", state: "running",
  session_id: "s1", error: null, created_at: 1, updated_at: 2, open_cards: 1, links: { discord: "https://discord.com/channels/1/2", web: "http://cc/sessions/s1" },
};

function respond(url: string, init?: RequestInit): Response {
  if (url === "/v1/desk/requests" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { client_request_id: string };
    return new Response(JSON.stringify({ request: { ...running, id: "req-2", request_key: `web:${body.client_request_id}`, state: "accepted", session_id: null, links: null }, existing: false }), { status: 202 });
  }
  if (url === "/v1/desk/requests") return new Response(JSON.stringify({ requests: [running] }));
  if (url === "/v1/desk/requests/routed") return new Response(JSON.stringify({
    request: { ...running, project_code: "Cc", task_reference: "actio:task-1", delivery: "waiting" },
    cards: [], gen5Stage: null,
  }));
  if (url === "/v1/desk/requests/delegated") return new Response(JSON.stringify({
    request: {
      ...running, project_code: "Cc", task_reference: "actio:task-2", delivery: "claimed",
      delegation_run_id: "run-2", child_session_id: "child-2",
    },
    cards: [], gen5Stage: null,
  }));
  if (url.startsWith("/v1/desk/requests/req-1")) return new Response(JSON.stringify({ request: running, gen5Stage: { label: "人間のプレイ確認", messageId: 4 }, cards: [{ id: "c1", card_kind: "human_judgment", summary: "方針を決める", state: "open", priority: "normal" }] }));
  if (url.startsWith("/v1/desk/requests/")) return new Response(JSON.stringify({ request: { ...running, id: "req-2", state: "accepted", session_id: null, links: null }, cards: [] }));
  if (url.startsWith("/v1/control/sessions")) return new Response(JSON.stringify({ error: "control_disabled" }), { status: 409 });
  if (url.startsWith("/v1/chores")) return new Response(JSON.stringify({ runs: [{ id: "old", prompt: "昔の雑務", provider: "claude", status: "acknowledged", cwd: "/c", output: "済", error: null, spawn_id: null }] }));
  return new Response("{}", { status: 404 });
}

async function render(path: string) {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => respond(String(url), init));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter initialEntries={[path]}><Desk /></MemoryRouter>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, fetcher, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe("依頼窓口 (/desk、Cc v5)", () => {
  it("shows the Actio reference and separates assignment from claim", async () => {
    const view = await render("/desk?request=routed");
    try {
      expect(view.container.textContent).toContain("actio:task-1");
      expect(view.container.textContent).toContain("プロジェクト管制の受付待ち");
      expect(view.container.textContent).toContain("プロジェクト管制の Web チャット");
      expect(view.container.textContent).not.toContain("実行セッション");
    } finally { await view.cleanup(); }
  });

  it("links to the delegated execution session and keeps the control session chat", async () => {
    const view = await render("/desk?request=delegated");
    try {
      const links = [...view.container.querySelectorAll("a")];
      expect(links.find((link) => link.textContent === "child-2")?.getAttribute("href")).toBe("/sessions/child-2");
      expect(links.find((link) => link.textContent === "プロジェクト管制の Web チャット")?.getAttribute("href")).toBe("http://cc/sessions/s1");
    } finally { await view.cleanup(); }
  });

  it("lists requests and shows the detail with session links, cards, and an explicit progress state", async () => {
    const view = await render("/desk?request=req-1");
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("README を直して");
      expect(text).toContain("作業中");
      expect(text).toContain("カード 1");
      expect(text).toContain("方針を決める");
      expect(text).toContain("人間のプレイ確認");
      expect(view.container.querySelectorAll("textarea")).toHaveLength(1);
      expect(view.container.querySelector('[aria-label="chat-s1"]')).not.toBeNull();
      expect(text).toContain("Discord のセッションチャンネル");
      expect(text).toContain("プランと進捗を取得できません: control_disabled");
      expect(text).toContain("過去の雑務 (1)");
    } finally { await view.cleanup(); }
  });

  it("submits a request with a client request id and reuses it for a same-content retry", async () => {
    const view = await render("/desk");
    try {
      const textarea = view.container.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(textarea, "新しい依頼");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const button = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "依頼する")!;
      await act(async () => { button.click(); });
      const posts = view.fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toMatchObject({ body: "新しい依頼", provider: "claude", client_request_id: expect.stringMatching(/^[A-Za-z0-9-]{8,}$/) });
    } finally { await view.cleanup(); }
  });

  it("sends the retired /chores page to /desk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter initialEntries={["/chores"]}><Routes><Route path="/chores" element={<Chores />} /><Route path="/desk" element={<p>desk-page</p>} /></Routes></MemoryRouter>); });
    expect(container.textContent).toBe("desk-page");
    await act(async () => root.unmount());
    container.remove();
  });
});
