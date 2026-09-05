/**
 * Transport-neutral collection of provider usage used by model selection.
 *
 * @implements spec/feature/subsidiary-delegation.md §3.1
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */

import { fetchClaudeOAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { fetchCodexRateLimits } from "../cost/codex-rate-limits.js";
import type { WeeklyQuotaWindow } from "./forum-model-selection.js";

export interface ForumModelUsageSnapshot {
  codexWeekly: WeeklyQuotaWindow | null;
  claudeWeekly: WeeklyQuotaWindow | null;
  fableUsedPct: number | null;
}

export interface ForumModelUsageDeps {
  log: { warn: (message: string) => void; info?: (message: string) => void };
  fetchCodex?: typeof fetchCodexRateLimits;
  fetchClaude?: typeof fetchClaudeOAuthUsage;
}

export async function collectForumModelUsage(deps: ForumModelUsageDeps): Promise<ForumModelUsageSnapshot> {
  const [codexRate, claudeUsage] = await Promise.all([
    (deps.fetchCodex ?? fetchCodexRateLimits)({ log: deps.log }).catch(() => null),
    (deps.fetchClaude ?? fetchClaudeOAuthUsage)({ log: deps.log }).catch(() => null),
  ]);
  return {
    codexWeekly: codexRate && codexRate.usedWeekly !== null
      ? { usedPct: codexRate.usedWeekly, resetAtSec: codexRate.resetWeeklyAt }
      : null,
    claudeWeekly: claudeUsage?.sevenDay
      ? { usedPct: claudeUsage.sevenDay.utilization, resetAtSec: claudeUsage.sevenDay.resetsAtSec }
      : null,
    fableUsedPct: claudeUsage?.sevenDayFable?.utilization ?? null,
  };
}
