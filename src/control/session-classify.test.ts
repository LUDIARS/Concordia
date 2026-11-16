import { describe, expect, it } from "vitest";
import { classifySession, STALL_IDLE_SEC, UNRESPONSIVE_NUDGE_MIN, type SessionClassifyInput } from "./session-classify.js";

function input(patch: Partial<SessionClassifyInput> = {}): SessionClassifyInput {
  return {
    idleSec: 100 * 60, humanWait: null, awaitingResult: null, uncommitted: false, workDone: null,
    unansweredNudges: 0, injectUnreflected: false, ...patch,
  };
}

describe("classifySession (CC-CTL-INV-09)", () => {
  it("classifies an idle session with no reason to wait as stalled, without any fingerprint input", () => {
    expect(classifySession(input())).toEqual({ status: "stalled", reason: "待つ理由なし / 無活動 100 分" });
    expect(classifySession(input({ uncommitted: true, unansweredNudges: 1 })).reason)
      .toBe("待つ理由なし / 無活動 100 分 / 未コミットの変更あり / 追加指示 1 回に未反応");
  });

  it("puts human waits and pending results before idleness, with the reason", () => {
    expect(classifySession(input({ humanWait: "質問カードの回答待ち", awaitingResult: "審査中 PR #1 (running)" })))
      .toEqual({ status: "human_wait", reason: "質問カードの回答待ち" });
    expect(classifySession(input({ awaitingResult: "審査中 PR #1 (running)" })))
      .toEqual({ status: "awaiting_result", reason: "審査中 PR #1 (running)" });
  });

  it("treats recent or unobserved activity as working", () => {
    expect(classifySession(input({ idleSec: STALL_IDLE_SEC - 60 })).status).toBe("working");
    expect(classifySession(input({ idleSec: null })).status).toBe("working");
    expect(classifySession(input({ idleSec: STALL_IDLE_SEC })).status).toBe("stalled");
  });

  it("makes finished work without uncommitted changes an end candidate only", () => {
    expect(classifySession(input({ workDone: "担当 PR #3 マージ済み" })))
      .toEqual({ status: "end_candidate", reason: "担当 PR #3 マージ済み / 無活動 100 分" });
    expect(classifySession(input({ workDone: "担当 PR #3 マージ済み", uncommitted: true })).status).toBe("stalled");
    expect(classifySession(input({ workDone: "担当 PR #3 マージ済み", uncommitted: null })).status).toBe("stalled");
  });

  it("promotes to unresponsive after the nudge limit or when a delivered nudge never reached the conversation", () => {
    expect(classifySession(input({ unansweredNudges: UNRESPONSIVE_NUDGE_MIN - 1 })).status).toBe("stalled");
    expect(classifySession(input({ unansweredNudges: UNRESPONSIVE_NUDGE_MIN })))
      .toEqual({ status: "unresponsive", reason: "追加指示 3 回に反応なし / 無活動 100 分" });
    expect(classifySession(input({ unansweredNudges: 1, injectUnreflected: true })))
      .toEqual({ status: "unresponsive", reason: "追加指示が会話に入っていない疑い / 無活動 100 分" });
  });
});
