import { describe, it, expect, beforeEach } from "vitest";
import { recordInjectAck, takeInjectAck, clearInjectAcks } from "./inject-ack.js";

describe("inject-ack tracker", () => {
  beforeEach(() => clearInjectAcks());

  it("record してから take で 1 回だけ取り出せる (delete-on-read)", () => {
    recordInjectAck("s1", "chan1", "msg1");
    const first = takeInjectAck("s1");
    expect(first).toEqual({ channelId: "chan1", messageId: "msg1", at: expect.any(Number) });
    // 2 回目は null → 二重リアクションしない
    expect(takeInjectAck("s1")).toBeNull();
  });

  it("未登録セッションは null", () => {
    expect(takeInjectAck("nope")).toBeNull();
  });

  it("同一セッションへの再 inject は最新で上書きされる", () => {
    recordInjectAck("s1", "c1", "m1");
    recordInjectAck("s1", "c2", "m2");
    expect(takeInjectAck("s1")).toMatchObject({ channelId: "c2", messageId: "m2" });
  });

  it("セッションごとに独立", () => {
    recordInjectAck("a", "ca", "ma");
    recordInjectAck("b", "cb", "mb");
    expect(takeInjectAck("a")).toMatchObject({ messageId: "ma" });
    expect(takeInjectAck("b")).toMatchObject({ messageId: "mb" });
  });
});
