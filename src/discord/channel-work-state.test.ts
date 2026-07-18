import { describe, it, expect, vi } from "vitest";
import { ChannelWorkState } from "./channel-work-state.js";

async function flushStateUpdates(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("ChannelWorkState", () => {
  it("最初の進捗で working=true、完了通知まで working を維持する", async () => {
    const calls: Array<{ sid: string; working: boolean }> = [];
    const t = new ChannelWorkState({
      setWorking: (sid, working) => { calls.push({ sid, working }); },
    });

    t.noteProgress("s1");
    await flushStateUpdates();
    expect(calls).toEqual([{ sid: "s1", working: true }]);
    expect(t.isWorking("s1")).toBe(true);

    // 連続進捗では再通知しない (working 維持)。
    t.noteProgress("s1");
    expect(calls.length).toBe(1);

    t.noteCompletion("s1");
    await flushStateUpdates();
    expect(calls).toEqual([
      { sid: "s1", working: true },
      { sid: "s1", working: false },
    ]);
    expect(t.isWorking("s1")).toBe(false);
  });

  it("完了後に再度進捗が来たら working に戻る", async () => {
    const calls: boolean[] = [];
    const t = new ChannelWorkState({ setWorking: (_sid, w) => { calls.push(w); } });
    t.noteProgress("s1");
    t.noteCompletion("s1");
    t.noteProgress("s1"); // 再開
    await flushStateUpdates();
    expect(calls).toEqual([true, false, true]);
  });

  it("状態更新を順序どおり直列化する", async () => {
    let releaseWorking!: () => void;
    const workingGate = new Promise<void>((resolve) => { releaseWorking = resolve; });
    const calls: boolean[] = [];
    const t = new ChannelWorkState({
      setWorking: async (_sid, working) => {
        calls.push(working);
        if (working) await workingGate;
      },
    });
    t.noteProgress("s1");
    t.noteCompletion("s1");
    await flushStateUpdates();
    expect(calls).toEqual([true]);

    releaseWorking();
    await flushStateUpdates();
    expect(calls).toEqual([true, false]);
  });

  it("clear で追跡状態を捨てる", () => {
    const t = new ChannelWorkState({ setWorking: vi.fn() });
    t.noteProgress("s1");
    t.clear("s1");
    expect(t.isWorking("s1")).toBe(false);
  });
});
