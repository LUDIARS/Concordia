import { describe, it, expect } from "vitest";
import {
  coerceGoalMode,
  parseGoalInput,
  readGoalFromMetadata,
  mergeGoalIntoMetadata,
  describeGoal,
  formatGoalBadge,
  goalDrivesAutoContinue,
  goalRequiresStepConfirm,
  DEFAULT_GOAL,
} from "./goal.js";

describe("coerceGoalMode", () => {
  it("明示値はそのまま", () => {
    expect(coerceGoalMode("complete")).toBe("complete");
    expect(coerceGoalMode("scoped")).toBe("scoped");
    expect(coerceGoalMode("watch")).toBe("watch");
  });
  it("自然文キーワードから推定", () => {
    expect(coerceGoalMode("様子見で")).toBe("watch");
    expect(coerceGoalMode("確認しながら進めて")).toBe("watch");
    expect(coerceGoalMode("月内目標まで")).toBe("scoped");
    expect(coerceGoalMode("完成まで")).toBe("complete");
  });
  it("該当なし/空は null", () => {
    expect(coerceGoalMode("よろしく")).toBeNull();
    expect(coerceGoalMode(null)).toBeNull();
  });
});

describe("parseGoalInput", () => {
  it("mode 明示を優先、 text は保持", () => {
    expect(parseGoalInput({ mode: "scoped", text: "月内 #441" })).toEqual({ mode: "scoped", text: "月内 #441" });
  });
  it("mode 無しは text から推定", () => {
    expect(parseGoalInput({ text: "様子見で頼む" })).toEqual({ mode: "watch", text: "様子見で頼む" });
  });
  it("どちらも無し/推定不能は既定 complete", () => {
    expect(parseGoalInput({})).toEqual({ mode: "complete" });
    expect(parseGoalInput({ text: "やってね" })).toEqual({ mode: "complete", text: "やってね" });
  });
});

describe("readGoalFromMetadata / mergeGoalIntoMetadata", () => {
  it("未設定/壊れは既定", () => {
    expect(readGoalFromMetadata(null)).toEqual(DEFAULT_GOAL);
    expect(readGoalFromMetadata("{bad")).toEqual(DEFAULT_GOAL);
    expect(readGoalFromMetadata('{"persona_id":"p1"}')).toEqual(DEFAULT_GOAL);
  });
  it("merge は既存キーを保持し goal を載せ、 read で往復する", () => {
    const merged = mergeGoalIntoMetadata('{"persona_id":"p1","role_label":"係"}', { mode: "scoped", text: "#441" });
    const o = JSON.parse(merged);
    expect(o.persona_id).toBe("p1");
    expect(o.role_label).toBe("係");
    expect(readGoalFromMetadata(merged)).toEqual({ mode: "scoped", text: "#441" });
  });
  it("空 text は正規化で落とす", () => {
    expect(readGoalFromMetadata(mergeGoalIntoMetadata(null, { mode: "complete", text: "  " }))).toEqual({ mode: "complete" });
  });
});

describe("describeGoal / formatGoalBadge", () => {
  it("mode 別の表示", () => {
    expect(describeGoal({ mode: "complete" })).toBe("完成まで実装");
    expect(describeGoal({ mode: "scoped", text: "月内 #441" })).toBe("範囲限定: 月内 #441");
    expect(describeGoal({ mode: "watch" })).toBe("様子見 (確認しながら)");
    expect(formatGoalBadge({ mode: "complete" })).toBe("🎯 完成まで実装");
  });
});

describe("predicates", () => {
  it("goal mode だけでは自動継続しない", () => {
    expect(goalDrivesAutoContinue("complete")).toBe(false);
    expect(goalDrivesAutoContinue("scoped")).toBe(false);
    expect(goalDrivesAutoContinue("watch")).toBe(false);
    expect(goalRequiresStepConfirm("watch")).toBe(true);
    expect(goalRequiresStepConfirm("complete")).toBe(false);
  });
});
