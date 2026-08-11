import { describe, expect, it, vi } from "vitest";
import {
  allowAutoInject,
  isBlockedByPendingQuestion,
  pendingQuestionProbe,
} from "./pending-question-blocker.js";

describe("pendingQuestionProbe", () => {
  it("未回答行があるセッションだけ blocked", () => {
    const probe = pendingQuestionProbe({
      findLatestUnanswered: (sessionId) => (sessionId === "s1" ? { id: 3 } : null),
    });
    expect(probe("s1")).toBe(true);
    expect(probe("s2")).toBe(false);
  });
});

describe("isBlockedByPendingQuestion", () => {
  it("probe 未注入なら従来動作 (止めない)", () => {
    expect(isBlockedByPendingQuestion(undefined, "s1")).toBe(false);
  });

  it("probe が落ちたら安全側で block する", () => {
    // 確認できない間だけ質問待ちへ自動 inject を通すと、blocker の契約を破る。
    const probe = () => { throw new Error("db closed"); };
    expect(isBlockedByPendingQuestion(probe, "s1")).toBe(true);
  });
});

describe("allowAutoInject", () => {
  it("未回答の質問があれば送らず、理由を残す", () => {
    const info = vi.fn();
    const allowed = allowAutoInject({
      probe: () => true,
      sessionId: "s1",
      source: "auto:goal-and-go",
      log: { info },
    });
    expect(allowed).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toContain("auto:goal-and-go");
    expect(info.mock.calls[0]![0]).toContain("s1");
  });

  it("回答済みなら通し、ログも出さない", () => {
    const info = vi.fn();
    expect(allowAutoInject({ probe: () => false, sessionId: "s1", source: "auto:inquiry", log: { info } })).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });
});
