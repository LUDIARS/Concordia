// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Control } from "./Control.js";

afterEach(() => { vi.unstubAllGlobals(); });

const card = {
  id: "card-1", source_kind: "human-command", card_kind: "human_action", summary: "gh auth login を打つ", session_id: "s1", project: "Cc",
  link: "http://cc/sessions/s1", state: "open", raised_at: Date.now() - 2 * 3_600_000, closed_at: null, priority: "high", assignee: "neco",
  remind_at: null, reminder_text: null, card_group: null, triaged_by: "dots:inst:dots:1",
};
const sessionRow = (id: string, progress: Record<string, unknown>) => ({
  session_id: id, project: id === "s1" ? "Concordia" : "Actio", branch: "feat/x", current_task: `作業 ${id}`, status: "working", status_reason: null,
  last_activity_at: 1, link: null,
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

async function render() {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => respond(String(url), init));
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Control />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, fetcher, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe("管制画面 (/control、Cc v5)", () => {
  it("shows cards, Actio tasks, running sessions with plan/progress, and sprints", async () => {
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("gh auth login を打つ");
      expect(text).toContain("優先度 高");
      expect(text).toContain("捌き: dots:inst:dots:1");
      expect(text).toContain("依頼窓口を作る");
      expect(text).toContain("PR #900");
      expect(text).toContain("Sprint 12");
      expect(text).toContain("ステップ 1 / 2");
      expect(text).toContain("作業段階: 実装");
    } finally { await view.cleanup(); }
  });

  it("shows 未計測 instead of 0% and 取得できません when Actio could not be read", async () => {
    const view = await render();
    try {
      const sessions = view.container.querySelector('[aria-label="動いているセッション"]')!;
      const [first, second] = [...sessions.querySelectorAll("article")];
      expect(first!.textContent).toContain("自動確認の進捗率: 未計測");
      expect(first!.textContent).not.toContain("0%");
      expect(first!.textContent).toContain("取得できません");
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
