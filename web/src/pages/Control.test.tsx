// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Control } from "./Control.js";
import { projectGraph } from "./control/projectGraph.js";
import type { SessionProgressRow } from "./control/controlApi.js";

afterEach(() => { vi.unstubAllGlobals(); });

const card = {
  id: "card-1", source_kind: "human-command", card_kind: "human_action", summary: "gh auth login を打つ", session_id: "s1", project: "Cc",
  link: "http://cc/sessions/s1", state: "open", raised_at: Date.now() - 2 * 3_600_000, closed_at: null, priority: "high", assignee: "neco",
  remind_at: null, reminder_text: null, card_group: null, triaged_by: "dots:inst:dots:1",
};
const sessionRow = (id: string, progress: Record<string, unknown>) => ({
  session_id: id, project: id === "s1" ? "Concordia" : "Actio", branch: "feat/x", current_task: `作業 ${id}`, status: "working", status_reason: null,
  last_activity_at: 1, link: null,
  gen5_stage: id === "s1" ? "人間のプレイ確認" : null,
  plan: { steps: [{ text: "設計", status: "completed" }, { text: "実装", status: "in_progress" }], desktop_plan_status: null, work_phase: { phase: "implementation", label: "実装", design_summary: "" } },
  progress: { steps_completed: 1, steps_total: 2, ...progress },
});

function respond(url: string, init?: RequestInit): Response {
  if (url.startsWith("/v1/control/cards/") && init?.method === "PATCH") return new Response(JSON.stringify({ card: { ...card, state: "closed" } }));
  if (url.startsWith("/v1/control/cards")) return new Response(JSON.stringify({ cards: [card] }));
  if (url.startsWith("/v1/control/sessions")) return new Response(JSON.stringify({ items: [
    sessionRow("s1", { followup_rate: null, tasks: { state: "unavailable" } }),
    sessionRow("s2", { followup_rate: 40, tasks: { state: "ok", items: [{ reference: "actio:9", status: "in_progress", state: "current" }] } }),
  ] }));
  if (url.startsWith("/v1/control/sprints")) return new Response(JSON.stringify({ sprints: [{ dialogue_key: "k", sprint_name: "Sprint 12", phase: "running", held: false, closed: false, task_count: 3, summary: "", actio_path: "/tasks/planning" }] }));
  if (url.includes("/v1/taskflow/overview")) return new Response(JSON.stringify({ generated_at: 1, counts: {}, tasks: [
    { path: "p1", repo_path: "r", title: "依頼窓口を作る", task: "t", project: "Concordia", kind: "feature", status: "in_progress", created: "", assignee: null,
      source_session: "s1", session_status: null, parent_session_id: null, child_session_id: null, delegation_run_id: null, delegation_status: null,
      team_id: null, subsidiary_id: null, pr: { number: 900, title: "v5", url: null, state: "open" }, ci_status: "none" },
  ] }));
  return new Response("{}", { status: 404 });
}

async function render(overview?: Response) {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) =>
    overview && String(url).includes("/v1/taskflow/overview") ? overview : respond(String(url), init));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Control />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, fetcher, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe("管制画面 (/control、Cc v5)", () => {
  it("shows the last snapshot and its age when the Actio refresh fails", async () => {
    const full = await respond("/v1/taskflow/overview").json();
    const fetchedAt = new Date(Date.now() - 120_000).toISOString();
    const view = await render(new Response(JSON.stringify({
      ...full, fetched_at: fetchedAt, stale: true, refreshing: false, refresh_error: "actio_read_timeout",
    })));
    try {
      const panel = view.container.querySelector('[aria-label="Actio タスク"]');
      expect(panel?.querySelector("time")?.getAttribute("datetime")).toBe(fetchedAt);
      expect(panel?.textContent).toContain("2 分前");
      expect(panel?.textContent).toContain("依頼窓口を作る");
      expect(panel?.querySelector('[role="alert"]')?.textContent).toContain("読み取りが時間切れ");
    } finally { await view.cleanup(); }
  });

  it("shows a cold refresh without declaring the task list empty", async () => {
    const view = await render(new Response(JSON.stringify({ tasks: [], fetched_at: null, refreshing: true })));
    try {
      const panel = view.container.querySelector('[aria-label="Actio タスク"]');
      expect(panel?.querySelector('[role="status"]')?.textContent).toContain("取得中");
      expect(panel?.textContent).not.toContain("進行中のタスクはありません");
    } finally { await view.cleanup(); }
  });
  it("keeps retrieved Actio rows visible with partial read guidance", async () => {
    const full = await respond("/v1/taskflow/overview").json();
    const view = await render(new Response(JSON.stringify({ ...full, partial_reason: "actio_read_timeout" })));
    try {
      const panel = view.container.querySelector('[aria-label="Actio タスク"]');
      expect(panel?.textContent).toContain("依頼窓口を作る");
      expect(panel?.querySelector('[role="alert"]')?.textContent).toContain("一部だけ取得");
      expect(panel?.textContent).toContain("読み取りが時間切れ");
      expect(panel?.textContent).not.toContain("処理結果");
    } finally { await view.cleanup(); }
  });

  it("does not report zero active tasks for an empty partial overview", async () => {
    const view = await render(new Response(JSON.stringify({ tasks: [], partial_reason: "actio_unreachable" })));
    try {
      const panel = view.container.querySelector('[aria-label="Actio タスク"]');
      expect(panel?.querySelector('[role="alert"]')?.textContent).toContain("接続できませんでした");
      expect(panel?.textContent).not.toContain("進行中のタスクはありません");
    } finally { await view.cleanup(); }
  });

  it("keeps the last successful snapshot during a failed wake refresh and recovers on online", async () => {
    const view = await render();
    try {
      view.fetcher.mockImplementation(async (url, init) => {
        if (String(url).startsWith("/v1/control/sessions")) throw new TypeError("fetch failed");
        return respond(String(url), init);
      });
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(view.container.textContent).toContain("Concordia");
      expect(view.container.textContent).toContain("再接続中");
      expect(view.container.textContent).not.toContain("fetch failed");

      view.fetcher.mockImplementation(async (url, init) => String(url).startsWith("/v1/control/sessions")
        ? new Response(JSON.stringify({ items: [] }))
        : respond(String(url), init));
      await act(async () => { window.dispatchEvent(new Event("online")); });
      expect(view.container.textContent).toContain("動いているセッションはありません");
      expect(view.container.textContent).not.toContain("再接続中");
      expect(view.fetcher.mock.calls.some(([url, init]) => String(url).includes("/v1/taskflow/overview") && Boolean(init?.signal))).toBe(true);
    } finally { await view.cleanup(); }
  });

  it("retains the Actio snapshot and its timestamp through a browser disconnect", async () => {
    const full = await respond("/v1/taskflow/overview").json();
    const fetchedAt = new Date(Date.now() - 120_000).toISOString();
    const view = await render(new Response(JSON.stringify({ ...full, fetched_at: fetchedAt, stale: true })));
    try {
      view.fetcher.mockImplementation(async (url, init) => {
        if (String(url).includes("/v1/taskflow/overview")) throw new TypeError("fetch failed");
        return respond(String(url), init);
      });
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      const panel = view.container.querySelector('[aria-label="Actio タスク"]');
      expect(panel?.textContent).toContain("再接続中");
      expect(panel?.textContent).toContain("依頼窓口を作る");
      expect(panel?.querySelector("time")?.getAttribute("datetime")).toBe(fetchedAt);
      expect(panel?.querySelector('[role="alert"]')).toBeNull();

      view.fetcher.mockImplementation(async (url, init) => String(url).includes("/v1/taskflow/overview")
        ? new Response(JSON.stringify({ ...full, tasks: [], fetched_at: fetchedAt, stale: false }))
        : respond(String(url), init));
      await act(async () => { window.dispatchEvent(new Event("online")); });
      expect(panel?.textContent).toContain("進行中のタスクはありません");
      expect(panel?.textContent).not.toContain("再接続中");
    } finally { await view.cleanup(); }
  });

  it("weights known steps, counts all sessions and leaves unmeasured projects unknown", () => {
    const row = (id: string, project: string, done: number, total: number) => ({
      ...sessionRow(id, {}), project, status: "human_wait",
      progress: { steps_completed: done, steps_total: total, followup_rate: null, tasks: { state: "unavailable" } },
    } as SessionProgressRow);
    const [a, b] = projectGraph([row("1", "A", 1, 2), row("2", "B", 0, 0), row("3", "A", 0, 0), row("4", "A", 0, 8)]);
    expect(a).toMatchObject({ name: "A", percent: 10, measured: 2, done: 1, total: 10 });
    expect(a!.counts.get("人間待ち")).toBe(3);
    expect(b!.percent).toBeNull();
  });

  it("shows cards, Actio tasks, running sessions with plan/progress, and sprints", async () => {
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("gh auth login を打つ");
      expect(text).toContain("優先度 高");
      expect(text).toContain("捌き: dots:inst:dots:1");
      expect(text).toContain("依頼窓口を作る");
      expect(text).not.toContain("PR #900");
      expect(text).toContain("Sprint 12");
      expect(text).toContain("計画進捗 50%");
      expect(text).toContain("オーバービュー");
    } finally { await view.cleanup(); }
  });

  it("shows 未計測 instead of 0% and 取得できません when Actio could not be read", async () => {
    const view = await render();
    try {
      const sessions = view.container.querySelector('[aria-label="動いているセッション"]')!;
      const select = async (name: string) => {
        const button = [...sessions.querySelectorAll("button")].find(b => b.textContent?.includes(name));
        expect(button).toBeDefined();
        await act(async () => { button!.click(); });
      };
      await select("Concordia");
      const first = sessions.querySelector("article")!;
      expect(first.textContent).toContain("作業 s1");
      expect(first.querySelector('[aria-label="Gen5 ワークフロー"] [aria-current="step"]')?.textContent).toBe("人間のプレイ確認");
      expect(first.querySelector('[aria-label="工程チャート"]')?.textContent).toContain("進行中 · 実装");
      expect(first!.textContent).toContain("自動確認の進捗率: 未計測");
      expect(first!.textContent).not.toContain("0%");
      expect(first!.textContent).toContain("取得できません");
      await select("マクロ");
      await select("Actio");
      const second = sessions.querySelector("article")!;
      expect(second.textContent).not.toContain("作業 s1");
      expect(second!.textContent).toContain("自動確認の進捗率: 40%");
      expect(second!.textContent).toContain("actio:9 (in_progress)");
    } finally { await view.cleanup(); }
  });

  it("marks a human-command card done through the card API", async () => {
    const view = await render();
    try {
      const open = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "捌きを変える")!;
      await act(async () => { open.click(); });
      const done = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "済み")!;
      await act(async () => { done.click(); });
      expect(view.fetcher).toHaveBeenCalledWith("/v1/control/cards/card-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ done: true }) }));
    } finally { await view.cleanup(); }
  });
});
