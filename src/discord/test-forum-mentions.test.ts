import { describe, expect, it, vi } from "vitest";
import type { SessionEventRow } from "../shared/types.js";
import { collectSessionOperators, resolveSessionMentions } from "./test-forum-mentions.js";

// 実 DB の session_events と同じ形: payload は JSON 文字列で、 人間 inject の
// source は "discord:<uid>:<channel>:<message>"。 制御 inject は別形式の文字列。
function injectEvent(source: string, text = "指示"): SessionEventRow {
  return {
    id: 1,
    session_id: "sess-1",
    kind: "inject",
    payload: JSON.stringify({ text, source }),
    ts: 1,
  } as unknown as SessionEventRow;
}

describe("collectSessionOperators", () => {
  it("collects distinct Discord users from human injects and skips control injects", () => {
    const events = [
      injectEvent("discord:111:ch-1:msg-1"),
      injectEvent("discord:222:ch-1:msg-2"),
      injectEvent("discord:111:ch-1:msg-3"),
      injectEvent("discord-enter-fallback"),
      { id: 9, session_id: "sess-1", kind: "report", payload: "{}", ts: 2 } as unknown as SessionEventRow,
      { id: 10, session_id: "sess-1", kind: "inject", payload: "not-json", ts: 3 } as unknown as SessionEventRow,
    ];
    expect(collectSessionOperators(events)).toEqual(["111", "222"]);
  });

  it("ignores slack operators (mentions are a Discord surface)", () => {
    expect(collectSessionOperators([injectEvent("slack:U123:ch:msg")])).toEqual([]);
  });
});

describe("resolveSessionMentions", () => {
  it("resolves each distinct session once and maps failures to empty lists", () => {
    const recentEvents = vi.fn((sessionId: string) => {
      if (sessionId === "sess-err") throw new Error("gone");
      return [injectEvent("discord:111:ch:msg")];
    });
    const mentions = resolveSessionMentions(recentEvents, ["sess-1", "sess-1", "sess-err"]);
    expect(recentEvents).toHaveBeenCalledTimes(2);
    expect(mentions.get("sess-1")).toEqual(["111"]);
    expect(mentions.get("sess-err")).toEqual([]);
  });
});
