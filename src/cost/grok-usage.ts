import { homedir } from "node:os";
import { join } from "node:path";
import { readTailLines } from "./channel-cost-cache.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:79768dce */
import augurContract_08bc6306 from './grok-usage.contract.js'; /* augur-inject:contract-predicate:0c4dd8fb */

const BILLING_EVENT = "billing: fetched credits config";
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

export interface GrokUsage {
  usedWeeklyPct: number;
  resetWeeklyAt: number;
  plan: string | null;
  observedAtSec: number;
}

interface BillingEntry {
  ts?: unknown;
  msg?: unknown;
  ctx?: {
    subscriptionTier?: unknown;
    config?: {
      creditUsagePercent?: unknown;
      currentPeriod?: { type?: unknown; end?: unknown };
      billingPeriodEnd?: unknown;
    };
  };
}

/** @implements CC-COST-QUOTA-INV-02 */
export function parseGrokBillingLogLine(line: string, nowSec: number): GrokUsage | null {
  let entry: BillingEntry | null;
  try {
    entry = JSON.parse(line) as BillingEntry | null;
  } catch {
    return null; // An append in progress may leave an incomplete JSON line.
  }
  if (entry?.msg !== BILLING_EVENT) return null;

  const config = entry.ctx?.config;
  const usedWeeklyPct = config?.creditUsagePercent;
  if (typeof usedWeeklyPct !== "number" || !Number.isFinite(usedWeeklyPct)
    || usedWeeklyPct < 0 || usedWeeklyPct > 100) return null;

  const period = config?.currentPeriod;
  if (period?.type != null && period.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
  const resetWeeklyAt = epochSeconds(period?.end ?? config?.billingPeriodEnd);
  const observedAtSec = epochSeconds(entry.ts);
  if (resetWeeklyAt === null || resetWeeklyAt <= nowSec || observedAtSec === null) return null;

  const tier = entry.ctx?.subscriptionTier;
  return { usedWeeklyPct, resetWeeklyAt, plan: typeof tier === "string" ? tier : null, observedAtSec };
}
// @ts-expect-error augur-inject
parseGrokBillingLogLine = contract(parseGrokBillingLogLine, { ...augurContract_08bc6306, contractId: 'weekly-ai-quota-C-1', mode: 'observe', sample: 1, where: 'src/cost/grok-usage.ts:29', rule: 'contract-wrap', id: '08bc6306' }); /* augur-inject:contract-wrap:08bc6306 */

export async function readGrokUsage(opts?: { grokHome?: string; nowSec?: number }): Promise<GrokUsage | null> {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const grokHome = opts?.grokHome ?? (process.env.GROK_HOME || join(homedir(), ".grok"));
  const lines = await readTailLines(join(grokHome, "logs", "unified.jsonl"), MAX_TAIL_BYTES);
  if (!lines) return null;

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes(BILLING_EVENT)) continue;
    const usage = parseGrokBillingLogLine(line, nowSec);
    if (usage) return usage;
  }
  return null;
}

function epochSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
