import { describe, expect, it } from "vitest";
import { isSessionIdle } from "./session-idle.js";

const FINAL = { role: "assistant", text: "完了しました", phase: "final_answer" };

describe("isSessionIdle (spec/feature/session-auto-succession.md §4.1, INV-3)", () => {
  it("完了境界の frame から quiet 秒経てば待機中", () => {
    expect(isSessionIdle({ ts: 1000, kind: "text", payload: FINAL }, 1060, 60)).toBe(true);
  });

  it("quiet 秒が経っていなければ待機中でない", () => {
    expect(isSessionIdle({ ts: 1000, kind: "text", payload: FINAL }, 1059, 60)).toBe(false);
  });

  it("frame が無いセッションは待機中としない", () => {
    expect(isSessionIdle(null, 9999, 60)).toBe(false);
  });

  it("作業中の frame (tool / commentary / user) は待機中でない", () => {
    expect(isSessionIdle({ ts: 0, kind: "tool_use", payload: {} }, 9999, 60)).toBe(false);
    expect(isSessionIdle({ ts: 0, kind: "text", payload: { role: "assistant", text: "調査中", phase: "commentary" } }, 9999, 60)).toBe(false);
    expect(isSessionIdle({ ts: 0, kind: "text", payload: { role: "user", text: "続けて" } }, 9999, 60)).toBe(false);
  });

  it("summary と phase 無しの assistant 最終文は完了境界", () => {
    expect(isSessionIdle({ ts: 0, kind: "summary", payload: {} }, 60, 60)).toBe(true);
    expect(isSessionIdle({ ts: 0, kind: "text", payload: { role: "assistant", text: "以上" } }, 60, 60)).toBe(true);
  });
});
