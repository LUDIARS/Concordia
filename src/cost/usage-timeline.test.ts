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
});
