import { describe, expect, it, vi } from "vitest";
import { applyDesktopPlanEvent, DESKTOP_PLAN_AUTHOR_LABEL, type DesktopPlanEventDeps } from "./desktop-plan-event.js";

function setup() {
  let metadata: Record<string, unknown> = {};
  const inserted: Array<Record<string, unknown>> = [];
  const applyTaskUpdate = vi.fn(() => ({ upserted: 0, completed_new: 0 }));
  const announce = vi.fn();
  const deps = {
    repo: { mergeMetadata: (_id: string, partial: Record<string, unknown>) => { metadata = { ...metadata, ...partial }; } },
    sessionTaskRecords: { applyTaskUpdate },
    chat: { insert: (message: Record<string, unknown>) => { inserted.push(message); return { id: inserted.length, ts: 1, ...message }; } },
    announce,
  } as unknown as DesktopPlanEventDeps;
  const session = () => ({ id: "s1", metadata: JSON.stringify(metadata) });
  return { deps, session, inserted, applyTaskUpdate, announce, metadata: () => metadata };
}

const PLAN = { tool: "update_plan", input: { items: [{ content: "調べる", status: "in_progress" }, { content: "直す", status: "pending" }] } };

describe("applyDesktopPlanEvent", () => {
  it("saves the plan with its status, mirrors the steps as task records and posts to the session thread", () => {
    const t = setup();
    expect(applyDesktopPlanEvent(t.deps, t.session(), PLAN, 100)).toEqual({ status: "作業中 (1/2): 調べる", posted: true });
    expect(t.metadata().desktop_plan).toMatchObject({ phase: "working", status: "作業中 (1/2): 調べる" });
    expect(t.applyTaskUpdate).toHaveBeenCalledWith({
      session_id: "s1",
      nowSec: 100,
      todos: [
        { content: "調べる", activeForm: "調べる", status: "in_progress" },
        { content: "直す", activeForm: "直す", status: "pending" },
      ],
    });
    expect(t.inserted).toEqual([expect.objectContaining({ channel: "system", session_id: "s1", author_label: DESKTOP_PLAN_AUTHOR_LABEL, is_actionable: false })]);
    expect(t.announce).toHaveBeenCalledTimes(1);
  });

  it("posts again only when the status changes, and posts the summary", () => {
    const t = setup();
    applyDesktopPlanEvent(t.deps, t.session(), PLAN, 100);
    expect(applyDesktopPlanEvent(t.deps, t.session(), PLAN, 101)).toMatchObject({ posted: false });
    expect(applyDesktopPlanEvent(t.deps, t.session(), { tool: "update_plan", input: { advance: true } }, 102))
      .toEqual({ status: "作業中 (2/2): 直す", posted: true });
    expect(applyDesktopPlanEvent(t.deps, t.session(), { tool: "wrap_up", input: { recap: "直しました。" } }, 103))
      .toEqual({ status: "完了", posted: true });
    expect(t.inserted).toHaveLength(3);
    expect(String(t.inserted[2]!.text)).toContain("直しました。");
  });

  it("ignores a payload that is not a plan call", () => {
    const t = setup();
    expect(applyDesktopPlanEvent(t.deps, t.session(), { tool: "Bash", input: {} }, 100)).toBeNull();
    expect(t.metadata()).toEqual({});
    expect(t.announce).not.toHaveBeenCalled();
  });
});
