/**
 * forum-model-suggest.ts へ渡す rate-limit 残量の取得 (I/O 側)。
 *
 * codex は `codex app-server` の rateLimits (codex-rate-limits.ts、4 分キャッシュ)、
 * claude は OAuth usage (anthropic-oauth-usage.ts、1 分キャッシュ)。 どちらも best-effort で、
 * 取れなければ null を渡し、サジェスト側が既定 (Claude / Opus) に倒す。
 *
 * Fable の使用量: transcript_logs (Lictor の raw frame) はキー名しか持たず model id も
 * usage も載らないため、そこからは取れない (2026-09-03 調査)。 OAuth usage が Fable 級の
 * 週間窓を返す場合だけ `fableUsedPct` になる。
 *
 * @implements spec/feature/subsidiary-delegation.md §3.1
 */

import { fetchClaudeOAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { fetchCodexRateLimits } from "../cost/codex-rate-limits.js";
import { suggestForumModel, type ForumModelSuggestion, type WeeklyQuotaWindow } from "./forum-model-suggest.js";
import type { ForumModelChoice } from "./forum-spawn.js";

export interface ForumModelUsageSnapshot {
  codexWeekly: WeeklyQuotaWindow | null;
  claudeWeekly: WeeklyQuotaWindow | null;
  fableUsedPct: number | null;
}

export interface ForumModelUsageDeps {
  log: { warn: (message: string) => void; info?: (message: string) => void };
  /** テスト差し替え用。 */
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

/** 残量を集めてサジェストまで一気に行う (bot.ts の質問カード掲出から呼ぶ)。 */
export async function suggestForumModelFromUsage(input: {
  title: string;
  body: string;
  choices: readonly ForumModelChoice[];
  log: ForumModelUsageDeps["log"];
  nowSec?: number;
}): Promise<ForumModelSuggestion | null> {
  const usage = await collectForumModelUsage({ log: input.log });
  return suggestForumModel({
    title: input.title,
    body: input.body,
    choices: input.choices,
    codexWeekly: usage.codexWeekly,
    claudeWeekly: usage.claudeWeekly,
    fableUsedPct: usage.fableUsedPct,
    nowSec: input.nowSec ?? Math.floor(Date.now() / 1000),
  });
}
