import { describe, expect, it } from "vitest";
import { applyDesktopPlanCall, parseDesktopPlanCall, readDesktopPlan, type DesktopPlanState } from "./plan-state.js";
import { desktopPlanPost, desktopPlanStatus } from "./plan-posts.js";

function call(payload: unknown) {
  const parsed = parseDesktopPlanCall(payload);
  if (!parsed) throw new Error("payload did not parse");
  return parsed;
}

const PLAN = call({
  tool: "update_plan",
  input: {
    scope: "first_task",
    items: [
      { content: "調べる", status: "in_progress" },
      { content: "直す", status: "pending" },
      { content: "確かめる", status: "pending" },
    ],
  },
});

function run(calls: unknown[]): { state: DesktopPlanState; posts: Array<string | null> } {
  let state: DesktopPlanState | null = null;
  const posts: Array<string | null> = [];
  for (const [index, payload] of calls.entries()) {
    const next: DesktopPlanState = applyDesktopPlanCall(state, call(payload), 100 + index);
    posts.push(desktopPlanPost(state, next));
    state = next;
  }
  if (!state) throw new Error("no calls");
  return { state, posts };
}

describe("desktop plan state", () => {
  it("builds the plan from the whole list and shows the step in progress as the status", () => {
    const state = applyDesktopPlanCall(null, PLAN, 100);
    expect(desktopPlanStatus(state)).toBe("作業中 (1/3): 調べる");
    expect(desktopPlanPost(null, state)).toBe("📋 **プラン** — 作業中 (1/3): 調べる\n▶ 調べる\n⏳ 直す\n⏳ 確かめる");
  });

  it("advances, completes by number and starts by number against the previous plan", () => {
    const { state, posts } = run([
      PLAN,
      { tool: "update_plan", input: { advance: true } },
      { tool: "update_plan", input: { done: [2], start: 3 } },
      { tool: "update_plan", input: { done: [9], start: 9 } },
    ]);
    expect(state.steps.map((step) => step.status)).toEqual(["completed", "completed", "in_progress"]);
    expect(posts[1]).toContain("作業中 (2/3): 直す");
    expect(posts[2]).toContain("作業中 (3/3): 確かめる");
    // 状態が変わらない更新は投稿しない。
    expect(posts[3]).toBeNull();
  });

  it("closes the plan with a summary and waits when the turn is blocked on the user", () => {
    const { state, posts } = run([
      PLAN,
      { tool: "wrap_up", input: { recap: "直しました。", ask: "コミットしますか?", actions: [{ label: "はい" }, { action: "commit" }], blocked: true } },
    ]);
    expect(state.steps.every((step) => step.status === "completed")).toBe(true);
    expect(desktopPlanStatus(state)).toBe("回答待ち");
    expect(posts[1]).toBe("📝 **サマリ** — 回答待ち\n直しました。\n\n✅ 調べる\n✅ 直す\n✅ 確かめる\n\n❓ コミットしますか?\n選択肢: はい / commit");
    const done = applyDesktopPlanCall(state, call({ tool: "wrap_up", input: { recap: "終わりました。" } }), 200);
    expect(desktopPlanStatus(done)).toBe("完了");
    // サマリはターンの区切りなので、 続けて出ても投稿する。
    expect(desktopPlanPost(state, done)).toContain("終わりました。");
  });

  it("posts nothing while there is neither a plan nor a summary", () => {
    const state = applyDesktopPlanCall(null, call({ tool: "update_plan", input: { advance: true } }), 100);
    expect(desktopPlanStatus(state)).toBeNull();
    expect(desktopPlanPost(null, state)).toBeNull();
  });

  it("rejects other payloads and reads back only a well-formed saved plan", () => {
    expect(parseDesktopPlanCall({ tool: "TodoWrite", input: {} })).toBeNull();
    expect(parseDesktopPlanCall({ tool: "wrap_up", input: {} })).toBeNull();
    const state = applyDesktopPlanCall(null, PLAN, 100);
    expect(readDesktopPlan(JSON.stringify({ desktop_plan: { ...state, status: "x" } }))?.steps).toHaveLength(3);
    expect(readDesktopPlan(JSON.stringify({ desktop_plan: { steps: "broken" } }))).toBeNull();
    expect(readDesktopPlan("not json")).toBeNull();
    expect(readDesktopPlan(null)).toBeNull();
  });
});
