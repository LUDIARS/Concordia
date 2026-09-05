/**
 * Transport-neutral model catalog and quota-selection primitives shared by
 * Session forum and GitHub Issue delegation.
 *
 * @implements spec/feature/subsidiary-delegation.md §3.1
 * @implements spec/feature/github-issue-workflow.md — モデル選定
 */

export const FORUM_MODEL_NICKS = ["fable", "opus", "sonnet", "sol", "terra"] as const;
export type ForumModelNick = (typeof FORUM_MODEL_NICKS)[number];
export const FORUM_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ForumEffort = (typeof FORUM_EFFORTS)[number];

export interface ForumModelChoice {
  nick: ForumModelNick;
  label: string;
  provider: string;
  model: string;
  emoji: string | null;
  defaultEffort: ForumEffort;
}

export interface ForumModelTemplate {
  call_name: string;
  is_active: boolean;
  target_provider?: string | null;
  model?: string | null;
  emoji?: string | null;
}

export function forumModelChoices(templates: readonly ForumModelTemplate[]): ForumModelChoice[] {
  const choices: ForumModelChoice[] = [];
  for (const nick of FORUM_MODEL_NICKS) {
    const found = templates
      .filter((candidate) => candidate.is_active && candidate.target_provider && candidate.model?.trim())
      .map((candidate) => {
        const name = candidate.call_name.toLowerCase();
        const rank = name === nick ? 0 : name === `${nick}-mid` ? 1 : name.startsWith(`${nick}-`) ? 2 : -1;
        return { candidate, name, rank };
      })
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))[0]?.candidate;
    if (!found) continue;
    const provider = found.target_provider!;
    choices.push({
      nick,
      label: `${nick[0]!.toUpperCase()}${nick.slice(1)} (${found.model!.trim()})`,
      provider,
      model: found.model!.trim(),
      emoji: found.emoji?.trim() || null,
      defaultEffort: provider === "claude" ? "high" : "xhigh",
    });
  }
  return choices;
}

export function normalizeForumEffort(provider: string, requested?: string | null): ForumEffort {
  const value = requested?.trim().toLowerCase() as ForumEffort | undefined;
  if (!value || !FORUM_EFFORTS.includes(value)) return provider === "claude" ? "high" : "xhigh";
  if (provider === "claude" && value === "minimal") return "low";
  return value;
}

export function matchExplicitForumModel(
  title: string,
  body: string,
  choices: readonly ForumModelChoice[],
): { choice: ForumModelChoice; effort?: ForumEffort } | null {
  const haystack = `${title}\n${body}`.toLowerCase();
  const matched = choices.filter(
    (choice) => containsAsciiIdentifier(haystack, choice.nick)
      || containsAsciiIdentifier(haystack, choice.model.toLowerCase()),
  );
  if (matched.length !== 1) return null;
  const effort = FORUM_EFFORTS.find(
    (candidate) => new RegExp(`(^|[^a-z])${candidate}([^a-z]|$)`).test(haystack),
  );
  return { choice: matched[0]!, ...(effort ? { effort } : {}) };
}

function containsAsciiIdentifier(haystack: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

export type ForumProviderFamily = "claude" | "codex";

export interface WeeklyQuotaWindow {
  usedPct: number | null;
  resetAtSec: number | null;
}

const MIN_REMAINING_DAYS = 0.25;
const DEFAULT_REMAINING_DAYS = 7;

export function remainingQuotaRatio(window: WeeklyQuotaWindow | null, nowSec: number): number | null {
  if (!window || window.usedPct === null || !Number.isFinite(window.usedPct)) return null;
  const remainPct = Math.max(0, Math.min(100, 100 - window.usedPct));
  const days = window.resetAtSec !== null && window.resetAtSec > nowSec
    ? Math.max(MIN_REMAINING_DAYS, (window.resetAtSec - nowSec) / 86_400)
    : DEFAULT_REMAINING_DAYS;
  return remainPct / days;
}

export function pickProviderFamilyByCostRatio(input: {
  codexWeekly: WeeklyQuotaWindow | null;
  claudeWeekly: WeeklyQuotaWindow | null;
  nowSec: number;
}): { family: ForumProviderFamily; codexRatio: number | null; claudeRatio: number | null } {
  const codexRatio = remainingQuotaRatio(input.codexWeekly, input.nowSec);
  const claudeRatio = remainingQuotaRatio(input.claudeWeekly, input.nowSec);
  if (codexRatio === null && claudeRatio === null) return { family: "claude", codexRatio, claudeRatio };
  if (codexRatio === null) return { family: "claude", codexRatio, claudeRatio };
  if (claudeRatio === null) return { family: "codex", codexRatio, claudeRatio };
  return { family: codexRatio > claudeRatio ? "codex" : "claude", codexRatio, claudeRatio };
}
