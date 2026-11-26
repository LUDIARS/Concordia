import { describe, expect, it } from "vitest";
import { errorFrame, eventFrame, HUB_CLOSE_CODES, MAX_FRAME_BYTES, parseFrame, resultFrame, toHubError, HubError } from "./protocol.js";
import { checkPayload, HUB_METHODS, isHubMethod, POSTING_METHODS } from "./methods.js";
import { HUB_LIMITS, KeyedThrottle, SlidingWindowLimiter } from "./rate-limit.js";

describe("GLab-UnityHub フレーム形式", () => {
  it("要求 {v,id,type,payload} を読む", () => {
    const parsed = parseFrame(JSON.stringify({ v: 1, id: "a1b2", type: "hub.whoami", payload: {} }));
    expect(parsed).toEqual({ kind: "request", request: { id: "a1b2", type: "hub.whoami", payload: {} } });
  });

  it("auth フレームは id なしでも読める", () => {
    expect(parseFrame(JSON.stringify({ v: 1, type: "auth", payload: { token: "t" } }))).toEqual({ kind: "auth", auth: { id: null, token: "t" } });
  });

  it("壊れたフレームは理由付きで invalid", () => {
    expect(parseFrame("not json").kind).toBe("invalid");
    expect(parseFrame(JSON.stringify({ v: 2, id: "x", type: "hub.whoami" }))).toMatchObject({ kind: "invalid", id: "x" });
    expect(parseFrame(JSON.stringify({ v: 1, type: "hub.whoami" }))).toMatchObject({ kind: "invalid", id: null });
    expect(parseFrame("x".repeat(MAX_FRAME_BYTES + 1)).kind).toBe("invalid");
  });

  it("応答・エラー・通知の形は契約どおり", () => {
    expect(JSON.parse(resultFrame("1", { ok: true }))).toEqual({ v: 1, id: "1", type: "result", payload: { ok: true } });
    expect(JSON.parse(errorFrame("1", "forbidden", "no"))).toEqual({ v: 1, id: "1", type: "error", payload: { code: "forbidden", message: "no" } });
    expect(JSON.parse(errorFrame(null, "internal", "x"))).toEqual({ v: 1, type: "error", payload: { code: "internal", message: "x" } });
    expect(JSON.parse(eventFrame("discord.message", { id: "m" }))).toEqual({ v: 1, type: "event", payload: { event: "discord.message", data: { id: "m" } } });
  });

  it("close code は 4401 / 4403", () => {
    expect(HUB_CLOSE_CODES).toEqual({ unauthorized: 4401, forbidden: 4403 });
  });

  it("内部例外は internal に落として文言を出さない", () => {
    expect(toHubError(new Error("secret path")).message).toBe("internal error");
    const known = new HubError("not_found", "x");
    expect(toHubError(known)).toBe(known);
  });
});

describe("GLab-UnityHub メソッド", () => {
  it("契約のメソッドを全部持つ", () => {
    expect(HUB_METHODS).toEqual(expect.arrayContaining([
      "hub.whoami", "hub.capabilities", "discord.channels.list", "discord.messages.list", "discord.messages.post",
      "discord.reactions.add", "discord.subscribe", "discord.unsubscribe", "breviarium.snapshot",
      "notion.board.query", "notion.board.update", "notion.board.create", "melpomene.report",
      "sprint.current", "sprint.tasks.update", "calliope.product", "calliope.refresh", "spec.list", "spec.get", "spec.review",
    ]));
    expect(isHubMethod("hub.nope")).toBe(false);
    expect(POSTING_METHODS.has("discord.messages.post")).toBe(true);
  });

  it("payload を検査する (limit ≤ 50・content ≤ 2000)", () => {
    expect(checkPayload("discord.messages.list", { channelId: "123456789012345678", limit: 50 }).ok).toBe(true);
    expect(checkPayload("discord.messages.list", { channelId: "123456789012345678", limit: 51 }).ok).toBe(false);
    expect(checkPayload("discord.messages.post", { channelId: "123456789012345678", content: "x".repeat(2001) }).ok).toBe(false);
    expect(checkPayload("spec.review", { id: "d", decision: "maybe" }).ok).toBe(false);
  });
});

describe("GLab-UnityHub 制限", () => {
  it("滑り窓で毎分の上限を守る", () => {
    const limiter = new SlidingWindowLimiter(HUB_LIMITS.postsPerUserPerMinute);
    for (let i = 0; i < 10; i += 1) expect(limiter.tryHit("u", 1_000 + i)).toBe(true);
    expect(limiter.tryHit("u", 2_000)).toBe(false);
    expect(limiter.tryHit("u", 61_001)).toBe(true);
  });

  it("キーごとに window 内 1 回だけ通す", () => {
    const throttle = new KeyedThrottle(HUB_LIMITS.overseasNoticeWindowMs);
    expect(throttle.tryPass("k", 0)).toBe(true);
    expect(throttle.tryPass("k", 59 * 60_000)).toBe(false);
    expect(throttle.tryPass("other", 1)).toBe(true);
    expect(throttle.nextAllowedAt("k", 10)).toBe(60 * 60_000);
    expect(throttle.tryPass("k", 60 * 60_000)).toBe(true);
  });
});
