import { describe, expect, it, vi } from "vitest";
import type { ProviderName } from "../../shared/types.js";
import { applySessionPlanEvent, type SessionPlanEventDeps } from "./session-plan-event.js";

function setup(provider: ProviderName = "claude-code") {
  let metadata: Record<string, unknown> = {};
  const inserted: Array<Record<string, unknown>> = [];
  const applyTaskUpdate = vi.fn(() => ({ upserted: 0, completed_new: 0 }));
  const announce = vi.fn();
  const deps = {
    repo: { mergeMetadata: (_id: string, partial: Record<string, unknown>) => { metadata = { ...metadata, ...partial }; } },
    sessionTaskRecords: { applyTaskUpdate },
    chat: { insert: (message: Record<string, unknown>) => { inserted.push(message); return { id: inserted.length, ts: 1, ...message }; } },
    announce,
  } as unknown as SessionPlanEventDeps;
  const session = () => ({ id: "s1", metadata: JSON.stringify(metadata), provider });
  return { deps, session, inserted, applyTaskUpdate, announce, metadata: () => metadata };
}

const PLAN = { tool: "update_plan", input: { items: [{ content: "調べる", status: "in_progress" }, { content: "直す", status: "pending" }] } };

describe("applySessionPlanEvent", () => {
  it("saves the plan with its status, mirrors the steps as task records and posts to the session thread", () => {
    const t = setup();
    expect(applySessionPlanEvent(t.deps, t.session(), PLAN, 100)).toEqual({ status: "作業中 (1/2): 調べる", posted: true });
    expect(t.metadata().desktop_plan).toMatchObject({ phase: "working", status: "作業中 (1/2): 調べる" });
    expect(t.applyTaskUpdate).toHaveBeenCalledWith({
      session_id: "s1",
      nowSec: 100,
      todos: [
        { content: "調べる", activeForm: "調べる", status: "in_progress" },
        { content: "直す", activeForm: "直す", status: "pending" },
      ],
    });
    expect(t.inserted).toEqual([expect.objectContaining({ channel: "system", session_id: "s1", author_label: "Claude プラン", is_actionable: false })]);
    expect(t.announce).toHaveBeenCalledTimes(1);
  });

  it("posts again only when the status changes, and posts the summary", () => {
    const t = setup();
    applySessionPlanEvent(t.deps, t.session(), PLAN, 100);
    expect(applySessionPlanEvent(t.deps, t.session(), PLAN, 101)).toMatchObject({ posted: false });
    expect(applySessionPlanEvent(t.deps, t.session(), { tool: "update_plan", input: { advance: true } }, 102))
      .toEqual({ status: "作業中 (2/2): 直す", posted: true });
    expect(applySessionPlanEvent(t.deps, t.session(), { tool: "wrap_up", input: { recap: "直しました。" } }, 103))
      .toEqual({ status: "完了", posted: true });
    expect(t.inserted).toHaveLength(3);
    expect(String(t.inserted[2]!.text)).toContain("直しました。");
  });

  it("ignores a payload that is not a plan call", () => {
    const t = setup();
    expect(applySessionPlanEvent(t.deps, t.session(), { tool: "Bash", input: {} }, 100)).toBeNull();
    expect(t.metadata()).toEqual({});
    expect(t.announce).not.toHaveBeenCalled();
  });

  it("handles a plan sent by an agy session the same way and posts it as the agy plan", () => {
    const t = setup("antigravity-cli");
    expect(applySessionPlanEvent(t.deps, t.session(), PLAN, 100)).toEqual({ status: "作業中 (1/2): 調べる", posted: true });
    // 保存先は従来のキーのまま (デスクトップ版と同じ metadata を読む)。
    expect(t.metadata().desktop_plan).toMatchObject({ phase: "working", status: "作業中 (1/2): 調べる" });
    expect(t.applyTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ session_id: "s1", todos: expect.arrayContaining([
      { content: "調べる", activeForm: "調べる", status: "in_progress" },
    ]) }));
    expect(t.inserted[0]).toMatchObject({ channel: "system", session_id: "s1", author_label: "agy プラン" });
    // 変わらない更新は投稿しない。
    expect(applySessionPlanEvent(t.deps, t.session(), PLAN, 101)).toEqual({ status: "作業中 (1/2): 調べる", posted: false });
    expect(t.inserted).toHaveLength(1);
  });

  it("closes an agy plan with wrap_up: done, or waiting when blocked on the user", () => {
    const t = setup("antigravity-cli");
    applySessionPlanEvent(t.deps, t.session(), PLAN, 100);
    expect(applySessionPlanEvent(t.deps, t.session(), { tool: "wrap_up", input: { recap: "調べました。", ask: "直しますか?", blocked: true } }, 101))
      .toEqual({ status: "回答待ち", posted: true });
    expect(t.metadata().desktop_plan).toMatchObject({ phase: "waiting", status: "回答待ち" });
    expect(applySessionPlanEvent(t.deps, t.session(), { tool: "wrap_up", input: { recap: "直しました。" } }, 102))
      .toEqual({ status: "完了", posted: true });
    expect(t.metadata().desktop_plan).toMatchObject({ phase: "summary", status: "完了" });
    expect(t.inserted.map((message) => message.author_label)).toEqual(["agy プラン", "agy プラン", "agy プラン"]);
  });
});
