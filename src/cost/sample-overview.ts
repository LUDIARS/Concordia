import type { SessionsRepo } from "../db/sessions-repo.js";
import type { CostUsageSampleRow, CostUsageSamplesRepo } from "../db/cost-usage-samples-repo.js";
import type { OrgCostReport, OrgCostRow, OrgCostSubsidiary, OrgCostWindows } from "./org-cost.js";
import type { ChannelCostRow } from "./channel-cost.js";
import { localDateIso } from "./usage-tracker.js";

export interface SampledCostOverview {
  windows: OrgCostWindows;
  channels: ChannelCostRow[];
}

export interface SampledCostOverviewDeps {
  sessions: SessionsRepo;
  samples: CostUsageSamplesRepo;
  subsidiaries: OrgCostSubsidiary[];
  resolveSessionChannelId: (sessionId: string) => string | null;
  nowMs?: number;
}

export function collectSampledCostOverview(deps: SampledCostOverviewDeps): SampledCostOverview {
  const nowMs = deps.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const todayStartSec = localMidnightSec(nowMs);
  const weekStartSec = localWeekStartSec(nowMs);
  const rows = deps.samples.listSince(weekStartSec);
  const active = deps.sessions.listSessions({ status: "active" });

  return {
    windows: {
      daily: buildReport({
        rows,
        subsidiaries: deps.subsidiaries,
        startSec: todayStartSec,
        endSec: nowSec + 1,
        label: localDateIso(nowMs),
        withBudget: true,
      }),
      weekly: buildReport({
        rows,
        subsidiaries: deps.subsidiaries,
        startSec: weekStartSec,
        endSec: nowSec + 1,
        label: `${localDateIso(weekStartSec * 1000)} - ${localDateIso(nowMs)}`,
        withBudget: false,
      }),
    },
    channels: buildChannelRows(active, rows, deps.resolveSessionChannelId),
  };
}

function localMidnightSec(nowMs: number): number {
  const d = new Date(nowMs);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
}

function localWeekStartSec(nowMs: number): number {
  const d = new Date(nowMs);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime() / 1000);
}

function buildReport(input: {
  rows: CostUsageSampleRow[];
  subsidiaries: OrgCostSubsidiary[];
  startSec: number;
  endSec: number;
  label: string;
  withBudget: boolean;
}): OrgCostReport {
  const knownSubs = new Set(input.subsidiaries.map((s) => s.id));
  const bySession = groupBySession(input.rows);
  const bySub = new Map<string, number>();
  let headOffice = 0;
  let total = 0;

  for (const rows of bySession.values()) {
    rows.sort((a, b) => a.ts - b.ts);
    let prevCost: number | null = null;
    for (const r of rows) {
      if (r.ts >= input.endSec) break;
      if (prevCost !== null && r.ts >= input.startSec) {
        const delta = r.cost_tokens - prevCost;
        if (delta > 0) {
          total += delta;
          const sid = r.subsidiary_id;
          if (sid && knownSubs.has(sid)) bySub.set(sid, (bySub.get(sid) ?? 0) + delta);
          else if (!sid) headOffice += delta;
        }
      }
      prevCost = r.cost_tokens;
    }
  }

  return {
    headOffice: { id: null, name: "本社", tokens: headOffice, budget: 0, blocked: false },
    subsidiaries: input.subsidiaries.map((sub) => {
      const tokens = bySub.get(sub.id) ?? 0;
      const budget = input.withBudget ? Math.max(0, Math.floor(sub.daily_token_budget || 0)) : 0;
      return {
        id: sub.id,
        name: sub.name,
        tokens,
        budget,
        blocked: budget > 0 && tokens >= budget,
      } satisfies OrgCostRow;
    }),
    totalTokens: total,
    label: input.label,
  };
}

function buildChannelRows(
  active: ReturnType<SessionsRepo["listSessions"]>,
  samples: CostUsageSampleRow[],
  channelOf: (sessionId: string) => string | null,
): ChannelCostRow[] {
  const latest = new Map<string, CostUsageSampleRow>();
  for (const s of samples) {
    const prev = latest.get(s.session_id);
    if (!prev || s.ts > prev.ts || (s.ts === prev.ts && s.id > prev.id)) latest.set(s.session_id, s);
  }

  const rows: ChannelCostRow[] = active.map((s) => {
    const sample = latest.get(s.id);
    return {
      sessionId: s.id,
      channelId: channelOf(s.id),
      provider: s.provider,
      contextTokens: sample?.context_tokens ?? null,
      costTokens: sample?.cost_tokens ?? 0,
    };
  });
  rows.sort((a, b) => (b.contextTokens ?? -1) - (a.contextTokens ?? -1) || b.costTokens - a.costTokens);
  return rows;
}

function groupBySession(rows: CostUsageSampleRow[]): Map<string, CostUsageSampleRow[]> {
  const out = new Map<string, CostUsageSampleRow[]>();
  for (const r of rows) {
    const arr = out.get(r.session_id);
    if (arr) arr.push(r);
    else out.set(r.session_id, [r]);
  }
  return out;
}
