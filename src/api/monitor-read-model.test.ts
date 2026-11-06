import { describe, expect, it, vi } from "vitest";
import { makeChatReadModel } from "./chat-read-models.js";
import type { ChatReadModelDeps } from "./chat-read-models.js";

vi.mock("../cost/channel-cost.js", () => ({ collectChannelCostRows: vi.fn(async () => []), renderChannelCostLines: () => [] }));

describe("getMonitorSnapshot scope and report provenance", () => {
  it("filters organizations and visibility before reading any report", async () => {
    const list = vi.fn(() => [{ author_type: "assistant", content: '```cc-progress\n' + JSON.stringify({
      task: "task", percent: 55, evidence: "実装済み", remaining: ["審査"], complete: false, at: new Date().toISOString(),
    }) + '\n```' }]);
    const deps = { sessionsRepo: { listSessions: () => [
      { id: "hq", current_task: "task", metadata: null },
      { id: "private", current_task: "secret", metadata: null },
      { id: "other", current_task: "other organization", metadata: '{"subsidiary_id":"other"}' },
    ] }, sessionMessages: { list } } as unknown as ChatReadModelDeps;
    const readModel = makeChatReadModel(deps);
    const snapshot = await readModel.getMonitorSnapshot({ channelForSession: id => id,
      canShowSession: id => id !== "private" });
    expect(snapshot.activeCount).toBe(1); expect(snapshot.sessions?.[0].progress?.percent).toBe(55);
    expect(list).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledWith("hq", { limit: 50 });
    const closed = await readModel.getMonitorSnapshot({ channelForSession: id => id });
    expect(closed.activeCount).toBe(0);
  });

  it("ignores human/tool percentages and preserves OFF and reported unknown", async () => {
    const deps = { sessionsRepo: { listSessions: () => [
      { id: "hq", current_task: "task", metadata: '{"goal_and_go":false}' },
    ] }, sessionMessages: { list: () => [{ author_type: "human", content: "100%" },
      { author_type: "tool", content: "```cc-progress\n{}\n```" }] } } as unknown as ChatReadModelDeps;
    const snapshot = await makeChatReadModel(deps).getMonitorSnapshot({ channelForSession: () => "channel", canShowSession: () => true });
    expect(snapshot.sessions?.[0]).toMatchObject({ progress: null, goalAndGo: "OFF" });
  });
});
