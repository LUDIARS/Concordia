import { describe, expect, it, vi } from "vitest";
import {
  DOTS_STALL_INTERVAL_FACTOR,
  isDotsStalled,
  readDotsStatusSafely,
  renderDotsStatusLines,
  type DotsMissionSnapshot,
} from "./dots-status.js";

const NOW = Date.UTC(2026, 10, 21, 3, 0, 0); // 2026-11-21 12:00 JST

function snapshot(patch: Partial<DotsMissionSnapshot> = {}): DotsMissionSnapshot {
  return {
    name: "品質任務", status: "active", pendingChanges: 0, lastDecisionAt: NOW - 10 * 60_000,
    waitingHuman: 0, launchFailed: 0, running: 0, reviewIntervalMinutes: 30, ...patch,
  };
}

describe("dots status in the control summary (spec/feature/control-session.md §11)", () => {
  it("shows nothing when there are no missions and says so when the read failed", () => {
    expect(renderDotsStatusLines([], NOW)).toEqual([]);
    expect(renderDotsStatusLines(null, NOW)).toEqual(["dots 連携: 状況を読めませんでした"]);
  });

  it("lists each mission with pending changes, last decision and request counts", () => {
    const lines = renderDotsStatusLines([
      snapshot({ pendingChanges: 3, running: 1, waitingHuman: 2, launchFailed: 1 }),
      snapshot({ name: "止めた任務", status: "stopped" }),
    ], NOW);
    expect(lines[0]).toBe("dots 連携: 任務 2 件 (動作中 1)");
    expect(lines[1]).toBe("- 品質任務: 未処理の変更 3 件 / 最後の判断 11:50 JST / 実行中 1 / 人間の判断待ち 2 / 起動失敗 1");
    expect(lines[2]).toBe("- 止めた任務: 停止中");
  });

  it("flags a mission whose pending changes waited more than twice the review interval", () => {
    const limit = 30 * 60_000 * DOTS_STALL_INTERVAL_FACTOR;
    expect(isDotsStalled(snapshot({ pendingChanges: 1, lastDecisionAt: NOW - limit - 1 }), NOW)).toBe(true);
    expect(isDotsStalled(snapshot({ pendingChanges: 1, lastDecisionAt: NOW - limit }), NOW)).toBe(false);
    expect(isDotsStalled(snapshot({ pendingChanges: 1, lastDecisionAt: null }), NOW)).toBe(true);
    expect(isDotsStalled(snapshot({ pendingChanges: 0, lastDecisionAt: null }), NOW)).toBe(false);
    expect(isDotsStalled(snapshot({ status: "stopped", pendingChanges: 5, lastDecisionAt: null }), NOW)).toBe(false);
    expect(renderDotsStatusLines([snapshot({ pendingChanges: 1, lastDecisionAt: null })], NOW)[1])
      .toBe("- 品質任務: 未処理の変更 1 件 / 判断の記録なし / 実行中 0 / ⚠ dots の判断が止まっています");
  });

  it("does not stop the summary when the read throws", () => {
    const warn = vi.fn();
    expect(readDotsStatusSafely(() => { throw new Error("db locked"); }, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db locked"));
    expect(readDotsStatusSafely(undefined, { warn })).toEqual([]);
    expect(readDotsStatusSafely(() => [snapshot()], { warn })).toHaveLength(1);
  });
});
