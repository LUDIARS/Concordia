import { describe, expect, it } from "vitest";
import { describeNudgeSkip, NUDGE_SKIP_METADATA_KEY, readNudgeSkip, recordNudgeSkip } from "./nudge-skip-record.js";

describe("nudge skip record", () => {
  it("logs the skip at info with session id and reason and keeps the last one in metadata", () => {
    let metadata: Record<string, unknown> = { other: 1 };
    const logs: Array<{ obj: Record<string, unknown>; message: string }> = [];
    const repo = { updateMetadata: (_id: string, update: (m: Record<string, unknown>) => Record<string, unknown>) => { metadata = update(metadata); } };
    const log = { info: (obj: Record<string, unknown>, message: string) => { logs.push({ obj, message }); } };
    recordNudgeSkip(repo as never, log, "s1", "previous_nudge_unanswered", 5_000);
    recordNudgeSkip(repo as never, log, "s1", "awaiting_human_input_ask", 9_000);
    expect(logs).toEqual([
      { obj: { session_id: "s1", reason: "previous_nudge_unanswered" }, message: "stall nudge skipped" },
      { obj: { session_id: "s1", reason: "awaiting_human_input_ask" }, message: "stall nudge skipped" },
    ]);
    expect(metadata).toEqual({ other: 1, [NUDGE_SKIP_METADATA_KEY]: { reason: "awaiting_human_input_ask", at: 9 } });
    const record = readNudgeSkip(JSON.stringify(metadata));
    expect(describeNudgeSkip(record)).toBe("ask で人間の入力待ち (at 9)");
  });

  it("does not throw when metadata cannot be written and ignores unknown records", () => {
    const repo = { updateMetadata: () => { throw new Error("db locked"); } };
    expect(() => recordNudgeSkip(repo as never, { info: () => {} }, "s1", "undeliverable", 1)).not.toThrow();
    expect(readNudgeSkip(JSON.stringify({ [NUDGE_SKIP_METADATA_KEY]: { reason: "nope", at: 1 } }))).toBeNull();
    expect(readNudgeSkip("not json")).toBeNull();
    expect(describeNudgeSkip(null)).toBeNull();
  });
});
