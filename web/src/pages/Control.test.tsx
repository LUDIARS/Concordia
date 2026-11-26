// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Control } from "./Control.js";
import { projectCards, projectGraph } from "./control/projectGraph.js";
import type { SessionProgressRow } from "./control/controlApi.js";

afterEach(() => { vi.unstubAllGlobals(); });

const card = {
  id: "card-1", source_kind: "human-command", card_kind: "human_action", summary: "gh auth login を打つ",
  human_action: "GitHub に再ログインする", session_id: "s1", project: "Cc",
  link: "http://cc/sessions/s1", state: "open", raised_at: Date.now() - 2 * 3_600_000, closed_at: null, priority: "high", assignee: "neco",
  remind_at: null, reminder_text: null, card_group: null, triaged_by: "dots:inst:dots:1",
};
const projectOnlyCard = { ...card, id: "card-2", project: "Concordia", session_id: null, human_action: "Concordia の設定を確認する" };
const otherCard = { ...card, id: "card-3", project: "Actio", session_id: "s2", human_action: "Actio の担当を決める" };
const weeklyQuotaRows = [
  { key: "chatgpt", label: "ChatGPT", remainWeeklyPct: 73.5, plan: "Pro", resetWeeklyAt: 1795622400 },
  { key: "claude", label: "Claude", remainWeeklyPct: 20, plan: null, resetWeeklyAt: null },
  { key: "gemini", label: "Gemini", remainWeeklyPct: 5, plan: null, resetWeeklyAt: null },
  { key: "grok", label: "Grok", remainWeeklyPct: null, plan: null, resetWeeklyAt: null },
];
const sessionRow = (id: string, progress: Record<string, unknown>) => ({
  session_id: id, project: id === "s1" ? "Concordia" : "Actio", branch: "feat/x", current_task: `作業 ${id}`, status: "working", status_reason: null,
  last_activity_at: 1, link: null,
  gen5_stage: id === "s1" ? "人間のプレイ確認" : null,
  plan: { steps: [{ text: "設計", status: "completed" }, { text: "実装", status: "in_progress" }], desktop_plan_status: null, work_phase: { phase: "implementation", label: "実装", design_summary: "" } },
  progress: { steps_completed: 1, steps_total: 2, ...progress },
});

function respond(url: string, init?: RequestInit): Response {
  if (url === "/v1/cost/limits/latest") return Response.json({ providers: weeklyQuotaRows });
  if (url.startsWith("/v1/control/cards/") && init?.method === "PATCH") return new Response(JSON.stringify({ card: { ...card, state: "closed" } }));
  if (url.startsWith("/v1/control/cards")) return new Response(JSON.stringify({ cards: [card, projectOnlyCard, otherCard] }));
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
  it("opens the weekly quota panel on demand and supports refreshing and closing", async () => {
    const view = await render();
    try {
      const trigger = view.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
      const dialog = () => view.container.querySelector<HTMLElement>('[role="dialog"]');
      const quotaCalls = () => view.fetcher.mock.calls.filter(([url]) => url === "/v1/cost/limits/latest");
      expect(quotaCalls()).toHaveLength(0);
      await act(async () => trigger.click());
      const rows = [...dialog()!.querySelectorAll("li")];
      expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual(["ChatGPT", "Claude", "Gemini", "Grok"]);
      expect(rows[0].textContent).toContain("残 73.5%");
      expect(rows[0].textContent).toContain("Pro");
      expect(rows[0].textContent).toContain(new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short" }).format(1795622400 * 1000));
      expect(rows[0].querySelector<HTMLElement>("[style]")?.style.width).toBe("73.5%");
      expect(rows[1].querySelector(".bg-amber-500")).toBeTruthy();
      expect(rows[2].querySelector(".bg-danger")).toBeTruthy();
      expect(rows[3].textContent).toContain("未計測");
      expect(rows[3].querySelector("[style]")).toBeNull();
      expect(dialog()!.textContent).not.toContain("5H");

      const refresh = [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "更新")!;
      await act(async () => refresh.click());
      expect(quotaCalls()).toHaveLength(2);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => trigger.click());
      await act(async () => dialog()!.parentElement!.click());
      expect(dialog()).toBeNull();
      await act(async () => trigger.click());
      await act(async () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="AI 残量を閉じる"]')!.click());
      expect(dialog()).toBeNull();
    } finally { await view.cleanup(); }
  });

  it("matches by project or session, retaining card order without duplicating dual matches", () => {
    const dual = { ...card, project: "Concordia" };
    expect(projectCards([card, otherCard, projectOnlyCard, dual], "Concordia", [{ session_id: "s1" }]))
      .toEqual([card, projectOnlyCard, dual]);
  });

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

  it("shows action headings with collapsed summaries, and limits micro cards to the selected project", async () => {
    const view = await render();
    try {
      const overview = view.container.querySelector('[aria-label="動いているセッション"]')!;
      const allCards = view.container.querySelector('[aria-label="管制カード"]')!;
      expect(overview.querySelector('[aria-label="関連する管制カード"]')).toBeNull();
      const first = allCards.querySelector("article")!;
      expect(first.firstElementChild?.textContent).toBe(card.human_action);
      expect(first.querySelector("details")?.open).toBe(false);
      expect(first.querySelector("details p")?.textContent).toBe(card.summary);
      const select = [...overview.querySelectorAll("button")].find(button => button.textContent?.includes("Concordia"))!;
      await act(async () => { select.click(); });
      const related = overview.querySelector('[aria-label="関連する管制カード"]')!;
      expect([...related.querySelectorAll("li h3")].map(heading => heading.textContent))
        .toEqual([card.human_action, projectOnlyCard.human_action]);
      expect(allCards.textContent).toContain(otherCard.human_action);
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
