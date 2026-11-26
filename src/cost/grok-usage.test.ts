import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGrokBillingLogLine, readGrokUsage } from "./grok-usage.js";

const observedAt = "2026-11-26T00:34:46.298Z";
const periodEnd = "2026-12-03T00:05:58.901+00:00";
const now = Math.floor(Date.parse(observedAt) / 1000);
const reset = Math.floor(Date.parse(periodEnd) / 1000);

function billing(config: Record<string, unknown>): string {
  return JSON.stringify({
    ts: observedAt,
    msg: "billing: fetched credits config",
    ctx: { config, subscriptionTier: "SuperGrok" },
  });
}

describe("parseGrokBillingLogLine", () => {
  it("extracts the weekly expiry and preserves percentage units", () => {
    expect(parseGrokBillingLogLine(billing({
      creditUsagePercent: 1.0,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: periodEnd },
      billingPeriodEnd: observedAt,
    }), now)).toEqual({ usedWeeklyPct: 1, resetWeeklyAt: reset, plan: "SuperGrok", observedAtSec: now });
  });

  it("uses the billing period fallback and preserves measured zero", () => {
    expect(parseGrokBillingLogLine(billing({ creditUsagePercent: 0, billingPeriodEnd: periodEnd }), now))
      .toMatchObject({ usedWeeklyPct: 0, resetWeeklyAt: reset });
  });

  it.each([undefined, null, "1", -1, 101])("rejects missing or invalid percentages (%s)", (value) => {
    expect(parseGrokBillingLogLine(billing({ creditUsagePercent: value, billingPeriodEnd: periodEnd }), now)).toBeNull();
  });

  it("rejects expired, non-weekly, malformed and unrelated entries", () => {
    expect(parseGrokBillingLogLine(billing({ creditUsagePercent: 1, billingPeriodEnd: periodEnd }), reset)).toBeNull();
    expect(parseGrokBillingLogLine(billing({
      creditUsagePercent: 1, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: periodEnd },
    }), now)).toBeNull();
    expect(parseGrokBillingLogLine("{", now)).toBeNull();
    expect(parseGrokBillingLogLine('{"msg":"unrelated"}', now)).toBeNull();
  });
});

describe("readGrokUsage", () => {
  let grokHome: string;

  beforeEach(async () => {
    grokHome = await mkdtemp(join(tmpdir(), "cc-grok-usage-"));
    await mkdir(join(grokHome, "logs"));
  });

  afterEach(async () => {
    await rm(grokHome, { recursive: true, force: true });
  });

  it("scans backwards, skipping an unfinished append", async () => {
    await writeFile(join(grokHome, "logs", "unified.jsonl"), [
      billing({ creditUsagePercent: 1, billingPeriodEnd: periodEnd }),
      billing({ creditUsagePercent: 5, billingPeriodEnd: periodEnd }),
      '{"msg":"billing: fetched credits config"',
    ].join("\n"));
    await expect(readGrokUsage({ grokHome, nowSec: now })).resolves.toMatchObject({ usedWeeklyPct: 5 });
    await expect(readGrokUsage({ grokHome, nowSec: reset })).resolves.toBeNull();
  });

  it("returns null for missing logs and observations outside the tail", async () => {
    await expect(readGrokUsage({ grokHome, nowSec: now })).resolves.toBeNull();
    await writeFile(join(grokHome, "logs", "unified.jsonl"),
      billing({ creditUsagePercent: 1, billingPeriodEnd: periodEnd }) + "\n" + " ".repeat(2 * 1024 * 1024));
    await expect(readGrokUsage({ grokHome, nowSec: now })).resolves.toBeNull();
  });
});
