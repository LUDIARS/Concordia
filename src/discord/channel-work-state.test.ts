import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelWorkState } from "./channel-work-state.js";

describe("ChannelWorkState", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("最初の進捗で working=true、idleMs 無進捗で working=false", () => {
    const calls: Array<{ sid: string; working: boolean }> = [];
    const t = new ChannelWorkState({
      idleMs: 600_000,
      setWorking: (sid, working) => calls.push({ sid, working }),
    });

    t.noteProgress("s1");
    expect(calls).toEqual([{ sid: "s1", working: true }]);
    expect(t.isWorking("s1")).toBe(true);

    // 連続進捗では再通知しない (working 維持)。
    t.noteProgress("s1");
    expect(calls.length).toBe(1);

    // idleMs 未満では idle にならない。
    vi.advanceTimersByTime(599_000);
    expect(calls.length).toBe(1);

    // 直前の進捗から idleMs 経過 → idle 復帰。
    vi.advanceTimersByTime(2_000);
    expect(calls).toEqual([
      { sid: "s1", working: true },
      { sid: "s1", working: false },
    ]);
    expect(t.isWorking("s1")).toBe(false);
  });

  it("idle 後に再度進捗が来たら working に戻る", () => {
    const calls: boolean[] = [];
    const t = new ChannelWorkState({ idleMs: 1000, setWorking: (_sid, w) => calls.push(w) });
    t.noteProgress("s1");
    vi.advanceTimersByTime(1000); // idle
    t.noteProgress("s1"); // 再開
    expect(calls).toEqual([true, false, true]);
  });

  it("clear でタイマ解除し以後 idle 通知しない", () => {
    const calls: boolean[] = [];
    const t = new ChannelWorkState({ idleMs: 1000, setWorking: (_sid, w) => calls.push(w) });
    t.noteProgress("s1");
    t.clear("s1");
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([true]); // idle(false) は来ない
    expect(t.isWorking("s1")).toBe(false);
  });
});
