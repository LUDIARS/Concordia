import { describe, expect, it } from "vitest";
import { buildCompletionCheckPrompt, buildProgressCheckPrompt, buildStoppedNotice, describePermissions } from "./prompts.js";
import type { DailyGoal } from "./domain.js";

const goal = {
  id: "g1", goalText: "出荷", acceptance: ["A", "B"], actioTaskIds: ["t1"],
  permissions: { merge: false, test: true, service: false, deploy: false },
} as DailyGoal;

describe("daily goal prompts", () => {
  it("shows なし when no Actio task is referenced", () => {
    expect(buildProgressCheckPrompt({ ...goal, actioTaskIds: [] }, [], "http://cc")).toContain("対応する Actio task: なし");
  });

  it("carries only the goal, acceptance, permissions and Actio task IDs plus the report APIs", () => {
    const text = buildProgressCheckPrompt(goal, ["commit:a"], "http://cc");
    expect(text).toContain("進捗確認");
    expect(text).toContain("1. A");
    expect(text).toContain("actio:t1");
    expect(text).toContain("マージ=不可");
    expect(text).toContain("http://cc/v1/daily-goals/g1/reached");
    expect(text).toContain("セッション外のタスク");
  });

  it("turns no progress into a completion check that does not stop", () => {
    const text = buildCompletionCheckPrompt(goal, "http://cc");
    expect(text).toContain("完了確認");
    expect(text).toContain("止めずに");
    expect(text).toContain("/exhausted");
  });

  it("tells the session to end through session-end without carrying the rest over", () => {
    expect(buildStoppedNotice(goal, "stopped")).toContain("人間が");
    expect(buildStoppedNotice(goal, "achieved")).toContain("session-end");
    expect(buildStoppedNotice(goal, "deadline")).toContain("締切");
    expect(describePermissions(goal.permissions)).toBe("マージ=不可 / テスト=可 / サービス操作=不可 / 反映=不可");
  });
});
