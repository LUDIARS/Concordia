import { describe, expect, it } from "vitest";
import { readUsageFrames, readSessionUsage } from "./log-usage.js";
import type { SessionRow } from "../shared/types.js";

function frame(overrides: Record<string, unknown> = {}) {
  return {
    type: "codex_usage",
    thread_id: "t1",
    turn_id: "turn-1",
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 30,
    total_tokens: 130,
    ...overrides,
  };
}

function session(provider: SessionRow["provider"]): SessionRow {
  return {
    id: "satelles-1",
    provider,
    repo_path: "E:/Document/Ars/Satelles",
    repo_origin: null,
    branch: null,
    host: "test",
    started_at: 0,
    ended_at: null,
    status: "active",
    last_seen_at: 0,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
  };
}

describe("readUsageFrames", () => {
  it("スレッド累積なので合算せず最大値を採る", () => {
    const totals = readUsageFrames([
      frame({ input_tokens: 100, output_tokens: 30, total_tokens: 130 }),
      frame({ turn_id: "turn-2", input_tokens: 300, output_tokens: 50, total_tokens: 350 }),
    ]);
    expect(totals).toEqual({ input: 300, cached: 20, output: 50, total: 350 });
  });

  it("thread が複数なら thread ごとの最大値を合算する", () => {
    const totals = readUsageFrames([
      frame({ thread_id: "t1", input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, total_tokens: 130 }),
      frame({ thread_id: "t1", input_tokens: 300, cached_input_tokens: 20, output_tokens: 50, total_tokens: 350 }),
      frame({ thread_id: "t2", input_tokens: 10, cached_input_tokens: 5, output_tokens: 4, total_tokens: 14 }),
    ]);
    expect(totals).toEqual({ input: 310, cached: 25, output: 54, total: 364 });
  });

  it("total が無ければ内訳から補う", () => {
    const totals = readUsageFrames([frame({ total_tokens: null, input_tokens: 7, output_tokens: 3 })]);
    expect(totals?.total).toBe(10);
  });

  it("codex_usage 以外のフレームは無視する", () => {
    expect(readUsageFrames([{ type: "codex_turn_completed", total_tokens: 999 }])).toBeNull();
    expect(readUsageFrames(["not an object", null, 42])).toBeNull();
  });

  it("トークンが 1 つも無いフレームは採らない", () => {
    expect(readUsageFrames([{ type: "codex_usage", thread_id: "t" }])).toBeNull();
  });

  it("負のトークン数 (壊れた frame) は 0 に潰す", () => {
    // frame は HTTP 越しの入力なので、 負値がそのまま合計に混ざらないこと。
    expect(
      readUsageFrames([frame({ input_tokens: -100, cached_input_tokens: -20, output_tokens: -30, total_tokens: -130 })]),
    ).toBeNull();
    expect(
      readUsageFrames([frame({ input_tokens: 100, cached_input_tokens: -20, output_tokens: 30, total_tokens: 130 })]),
    ).toEqual({ input: 100, cached: 0, output: 30, total: 130 });
  });
});

describe("readSessionUsage (codex-sdk)", () => {
  it("frame ソースから読む", async () => {
    const totals = await readSessionUsage(session("codex-sdk"), {
      listUsagePayloads: () => [frame()],
    });
    expect(totals).toEqual({ input: 100, cached: 20, output: 30, total: 130 });
  });

  it("frame ソースが無ければ従来どおり未計測 (null)", async () => {
    expect(await readSessionUsage(session("codex-sdk"))).toBeNull();
  });

  it("frame が空なら null (0 を実測値と偽らない)", async () => {
    expect(await readSessionUsage(session("codex-sdk"), { listUsagePayloads: () => [] })).toBeNull();
  });
});
