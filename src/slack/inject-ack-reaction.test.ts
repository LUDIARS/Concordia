import { describe, expect, it, vi } from "vitest";
import { createSlackInjectAck, SLACK_ACCEPTED_INJECT_REACTION } from "./inject-ack-reaction.js";

function harness(add = vi.fn(async (_args: { channel: string; timestamp: string; name: string }) => ({ ok: true }))) {
  const warn = vi.fn();
  const ack = createSlackInjectAck({ web: { reactions: { add } }, log: { warn } });
  return { ack, add, warn };
}

describe("createSlackInjectAck", () => {
  it("記録した投稿に、セッションが動いたとき ✅ を 1 回だけ付ける", async () => {
    const { ack, add } = harness();
    ack.record("s1", "C1", "100.1");
    await ack.onSessionProgress("s1");
    await ack.onSessionProgress("s1");
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({ channel: "C1", timestamp: "100.1", name: SLACK_ACCEPTED_INJECT_REACTION });
  });

  it("記録の無いセッションの進捗では何も付けない", async () => {
    const { ack, add } = harness();
    ack.record("s1", "C1", "100.1");
    await ack.onSessionProgress("s2");
    expect(add).not.toHaveBeenCalled();
  });

  it("同じセッションへの再指示は最新の投稿だけに付ける", async () => {
    const { ack, add } = harness();
    ack.record("s1", "C1", "100.1");
    ack.record("s1", "C1", "100.2");
    await ack.onSessionProgress("s1");
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ timestamp: "100.2" }));
  });

  it("付与の失敗は例外にせずログだけ残す (already_reacted はログも出さない)", async () => {
    const missingScope = Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } });
    const already = Object.assign(new Error("An API error occurred: already_reacted"), { data: { error: "already_reacted" } });
    const add = vi.fn().mockRejectedValueOnce(missingScope).mockRejectedValueOnce(already);
    const { ack, warn } = harness(add);
    ack.record("s1", "C1", "100.1");
    await expect(ack.onSessionProgress("s1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing_scope"));
    ack.record("s1", "C1", "100.2");
    await ack.onSessionProgress("s1");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
