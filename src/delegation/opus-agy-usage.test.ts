import { describe, expect, it } from "vitest";
import { collectAgyClaudeRemainingPct } from "./opus-agy-usage.js";

const NOW_MS = 1_795_000_000_000;
const row = { group: "Claude and GPT models", label: "Weekly Limit Remaining", window: "weekly" as const,
  usedPct: 40, resetsAtSec: NOW_MS / 1000 + 60 };

describe("collectAgyClaudeRemainingPct", () => {
  it("returns the Claude remaining percent from agy usage", async () => {
    const fetch = async () => ({ fiveHour: null, weekly: null, others: [row], fetchedAt: NOW_MS });
    expect(await collectAgyClaudeRemainingPct(fetch, () => NOW_MS)).toBe(60);
  });

  it("treats a fetch failure as unknown (keeps Opus)", async () => {
    expect(await collectAgyClaudeRemainingPct(async () => null, () => NOW_MS)).toBeNull();
    expect(await collectAgyClaudeRemainingPct(async () => { throw new Error("spawn ENOENT"); }, () => NOW_MS)).toBeNull();
  });
});
