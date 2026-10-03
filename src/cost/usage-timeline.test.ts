import { describe, expect, it } from "vitest";
import { claudeUsagePoints, codexUsagePoints } from "./usage-timeline.js";

describe("claudeUsagePoints", () => {
  it("assistant の usage を時刻つきで取り、 同じ message id は 1 回だけ数える", () => {
    const line = (id: string, ts: string, input: number, output: number) =>
      JSON.stringify({ timestamp: ts, message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 999 } } });
    const points = claudeUsagePoints([
      JSON.stringify({ type: "mode", sessionId: "x" }),
      line("m1", "2026-10-02T00:00:01.000Z", 10, 5),
      line("m1", "2026-10-02T00:00:02.000Z", 10, 5),
      line("m2", "2026-10-02T00:00:03.000Z", 1, 1),
      "not json",
    ]);
    expect(points).toEqual([
      { atMs: Date.parse("2026-10-02T00:00:01.000Z"), tokens: 15 },
      { atMs: Date.parse("2026-10-02T00:00:03.000Z"), tokens: 2 },
    ]);
  });

  it("stop_reason が tool_use 以外の message を AI の最終回答 (区間の切れ目) にする", () => {
    const line = (id: string, ts: string, stopReason: string | null, output: number) =>
      JSON.stringify({ timestamp: ts, message: { id, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: output } } });
    const points = claudeUsagePoints([
      line("m1", "2026-10-02T00:00:01.000Z", "tool_use", 4),
      line("m2", "2026-10-02T00:00:02.000Z", null, 9),
      // 同じ message の後の行にだけ stop_reason が載っていても印を付ける。
      line("m2", "2026-10-02T00:00:02.500Z", "end_turn", 9),
      line("m3", "2026-10-02T00:00:03.000Z", null, 1),
    ]);
    expect(points).toEqual([
      { atMs: Date.parse("2026-10-02T00:00:01.000Z"), tokens: 5 },
      { atMs: Date.parse("2026-10-02T00:00:02.000Z"), tokens: 10, turnEnd: true },
      { atMs: Date.parse("2026-10-02T00:00:03.000Z"), tokens: 2 },
    ]);
  });
});

describe("codexUsagePoints", () => {
  it("累積トークンの増分を時刻つきで取る", () => {
    const line = (ts: string, total: number) => JSON.stringify({
      timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total } } },
    });
    expect(codexUsagePoints([
      line("2026-10-02T00:00:01.000Z", 100),
      line("2026-10-02T00:00:02.000Z", 100),
      line("2026-10-02T00:00:03.000Z", 250),
    ])).toEqual([
      { atMs: Date.parse("2026-10-02T00:00:01.000Z"), tokens: 100 },
      { atMs: Date.parse("2026-10-02T00:00:03.000Z"), tokens: 150 },
    ]);
  });

  it("task_complete を消費 0 の最終回答の印として取る", () => {
    expect(codexUsagePoints([
      JSON.stringify({ timestamp: "2026-10-02T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 70 } } } }),
      JSON.stringify({ timestamp: "2026-10-02T00:00:02.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }),
    ])).toEqual([
      { atMs: Date.parse("2026-10-02T00:00:01.000Z"), tokens: 70 },
      { atMs: Date.parse("2026-10-02T00:00:02.000Z"), tokens: 0, turnEnd: true },
    ]);
  });
});
