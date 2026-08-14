/**
 * /cost — Concordia 自身のセッションコスト + クロスサービス feed。
 *
 * 上段: Discord の「Concordia Monitor」「コスト」チャンネルと同じ内容を WebUI でも詳細表示。
 *   - 本社/子会社別 (本日・週間) トークン
 *   - チャンネル (セッション) 別の現在の 🧠 コンテキスト占有 / 💰 累積コスト
 *   - 10 分毎サンプルの時系列グラフ (使用量 / コンテキスト / セッション数)
 * 下段: 他サービス (Discutere 等) が POST /v1/cost-feed で push した横断コスト。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type CostFeedReport,
  type CostAgg,
  type CostOverview,
  type TeamCostSeries,
  type UsageTimeseries,
  type LimitTimeseries,
  type OrgCostReport,
} from "../api.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { useTeamFilter } from "../lib/TeamFilterContext.js";
import { filterChannelsByTeam } from "./teams/model.js";

const usd = (v: number) => "$" + (Number(v) || 0).toFixed(4);
const n = (v: number) => (Number(v) || 0).toLocaleString();
const tok = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return "—";
  const x = Math.max(0, Math.floor(v));
  if (x < 1000) return String(x);
  if (x < 1_000_000) return (x / 1000).toFixed(1) + "k";
  return (x / 1_000_000).toFixed(2) + "M";
};
const providerColors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
const pct = (v: number | null): string => v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;

function OrgBlock({ report, heading }: { report: OrgCostReport; heading: string }) {
  return (
    <div>
      <div className="text-xs text-subtle mb-1">
        {heading} <span className="opacity-60">({report.label})</span>
      </div>
      <table className="w-full text-sm border-collapse">
        <tbody>
          <tr className="border-t border-border/50">
            <td className="py-1 text-text">🏠 本社</td>
            <td className="py-1 text-right text-text">{tok(report.headOffice.tokens)}</td>
          </tr>
          {report.subsidiaries.map((s) => (
            <tr key={s.id ?? s.name} className="border-t border-border/50">
              <td className="py-1 text-text">🏢 {s.name}{s.blocked ? " ⚠️" : ""}</td>
              <td className="py-1 text-right text-text">
                {tok(s.tokens)}
                {s.budget > 0 && <span className="text-subtle text-xs"> / {tok(s.budget)}</span>}
              </td>
            </tr>
          ))}
          <tr className="border-t border-border">
            <td className="py-1 text-subtle">合計</td>
            <td className="py-1 text-right text-subtle">{tok(report.totalTokens)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function FeedRow({ label, a }: { label: string; a: CostAgg }) {
  return (
    <tr className="border-t border-border/50">
      <td className="py-1 pr-3 text-text">{label}</td>
      <td className="py-1 pl-3 text-right text-subtle">{a.sessions}</td>
      <td className="py-1 pl-3 text-right text-subtle">{a.calls}</td>
      <td className="py-1 pl-3 text-right text-subtle">{n(a.cacheReadTokens)}</td>
      <td className="py-1 pl-3 text-right text-text">{usd(a.costUsd)}</td>
    </tr>
  );
}

export function CostFeed() {
  const { teamId, team } = useTeamFilter();
  const [overview, setOverview] = useState<CostOverview | null>(null);
  const [series, setSeries] = useState<UsageTimeseries | null>(null);
  const [limits, setLimits] = useState<LimitTimeseries | null>(null);
  const [feed, setFeed] = useState<CostFeedReport | null>(null);
  const [teamSessionIds, setTeamSessionIds] = useState<string[] | null>(null);
  const [teamSeries, setTeamSeries] = useState<TeamCostSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    setTeamSessionIds(teamId ? [] : null);
    setTeamSeries(null);
    const started = performance.now();
    try {
      const [ov, ts, lim, fd, teamSessions, teamCost] = await Promise.all([
        timed("overview", () => api.costOverview()),
        timed("timeseries", () => api.costTimeseries({ bucketSec: 600 })),
        timed("limit-timeseries", () => api.costLimitTimeseries()),
        timed("cost-feed", () => api.costFeed().catch(() => null)),
        teamId ? timed("team-sessions", () => api.sessions({ teamId })) : Promise.resolve(null),
        teamId ? timed("team-cost", () => api.teamCost(teamId, { bucketSec: 3600 })) : Promise.resolve(null),
      ]);
      if (generation !== requestGenerationRef.current) return;
      setOverview(ov);
      setSeries(ts);
      setLimits(lim);
      setFeed(fd);
      setTeamSessionIds(teamSessions ? teamSessions.sessions.map((s) => s.id) : null);
      setTeamSeries(teamCost);
      console.info(`[CostFeed] total loaded in ${Math.round(performance.now() - started)}ms`);
    } catch (e) {
      if (generation === requestGenerationRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
    return () => { requestGenerationRef.current += 1; };
  }, [load]);

  const visibleChannels = useMemo(
    () => filterChannelsByTeam(overview?.channels ?? [], teamSessionIds),
    [overview, teamSessionIds],
  );

  const feedEmpty = !feed || feed.total.calls === 0;
  const points = series?.points ?? [];
  const xLabels = points.map((p) =>
    new Date(p.ts * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
  );
  const providerSpentSeries = Object.entries(series?.providers ?? {}).map(([provider, rows], i) => {
    const byTs = new Map(rows.map((p) => [p.ts, p.spentTokens]));
    return {
      label: provider,
      color: providerColors[i % providerColors.length],
      values: points.map((p) => byTs.get(p.ts) ?? 0),
      fmt: tok,
    };
  });
  const limitTs = Array.from(new Set((limits?.points ?? []).map((p) => p.ts))).sort((a, b) => a - b);
  const limitLabels = limitTs.map((ts) =>
    new Date(ts * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
  );
  const limitLabel = (provider: string, rows: Array<{ plan: string | null }>): string => {
    const plan = [...rows].reverse().find((p) => p.plan)?.plan;
    return plan ? `${provider} (${plan})` : provider;
  };
  const weeklyLimitSeries = Object.entries(limits?.providers ?? {}).map(([provider, rows], i) => {
    const byTs = new Map(rows.map((p) => [p.ts, p.usedWeeklyPct]));
    return { label: limitLabel(provider, rows), color: providerColors[i % providerColors.length], values: carryForward(limitTs.map((ts) => byTs.get(ts) ?? null)), fmt: pct };
  });
  const shortLimitSeries = Object.entries(limits?.providers ?? {}).map(([provider, rows], i) => {
    const byTs = new Map(rows.map((p) => [p.ts, p.used5hPct]));
    return { label: limitLabel(provider, rows), color: providerColors[i % providerColors.length], values: carryForward(limitTs.map((ts) => byTs.get(ts) ?? null)), fmt: pct };
  });

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-center gap-3">
        <h1 className="font-semibold">
          Cost
          {team && <span className="ml-2 text-xs font-normal text-subtle">チーム表示: {team.name}</span>}
        </h1>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto text-xs px-2 py-1 rounded border border-border text-subtle hover:text-text disabled:opacity-50"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </header>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      {/* チーム選択時: 当該チームの消費トークン系列 (/v1/teams/:id/cost) */}
      {team && teamSeries && (
        <section className="bg-surface border border-border rounded p-4 space-y-2">
          <h2 className="text-sm font-semibold text-text">チーム消費 ({team.name})</h2>
          {teamSeries.points.length === 0 ? (
            <div className="text-subtle text-sm">このチームのコストサンプルはまだありません。</div>
          ) : (
            <TimeSeriesChart
              xLabels={teamSeries.points.map((p) =>
                new Date(p.ts * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", hour12: false }),
              )}
              series={[{ label: "💰 消費/時", color: "#f59e0b", values: teamSeries.points.map((p) => p.cost_tokens), fmt: tok }]}
              height={160}
            />
          )}
        </section>
      )}

      <section className="bg-surface border border-border rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold text-text">Provider 利用制限 (週間・全体)</h2>
        <TimeSeriesChart xLabels={limitLabels} series={weeklyLimitSeries} height={180} maxValue={100} />
      </section>

      <section className="bg-surface border border-border rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold text-text">Provider 利用制限 (日別/5H・全体)</h2>
        <TimeSeriesChart xLabels={limitLabels} series={shortLimitSeries} height={180} maxValue={100} />
      </section>

      {/* ① 本社/子会社別 (本日・週間) */}
      {overview && (
        <section className="bg-surface border border-border rounded p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text">本社 / 子会社別 (トークン・全体)</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <OrgBlock report={overview.windows.daily} heading="本日" />
            <OrgBlock report={overview.windows.weekly} heading="週間" />
          </div>
        </section>
      )}

      {/* ② 時系列グラフ */}
      <section className="bg-surface border border-border rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold text-text">使用量の推移 (10 分毎・全体)</h2>
        <TimeSeriesChart
          xLabels={xLabels}
          series={[
            { label: "💰 消費/10分", color: "#f59e0b", values: points.map((p) => p.spentTokens), fmt: tok },
            { label: "🧠 コンテキスト", color: "#38bdf8", values: points.map((p) => p.contextTokens), fmt: tok },
            ...providerSpentSeries,
            { label: "セッション数", color: "#a3a3a3", values: points.map((p) => p.sessions) },
          ]}
        />
        <p className="text-[10px] text-subtle">
          各系列は最大値で正規化して重ねています。💰 = そのバケットで消費したトークン、🧠 = 全セッションのコンテキスト占有合計。
        </p>
      </section>

      {/* ③ チャンネル (セッション) 別 */}
      {overview && (
        <section className="bg-surface border border-border rounded p-4 space-y-2">
          <h2 className="text-sm font-semibold text-text">
            チャンネル別 <span className="text-subtle font-normal text-xs">🧠 コンテキスト占有 / 💰 累積コスト</span>
          </h2>
          {visibleChannels.length === 0 ? (
            <div className="text-subtle text-sm">
              {team ? "このチームのアクティブセッションはありません。" : "アクティブセッションはありません。"}
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <tbody>
                {visibleChannels.map((c) => (
                  <tr key={c.sessionId} className="border-t border-border/50">
                    <td className="py-1 text-text font-mono text-xs">
                      {c.channelId ? `#${c.channelId.slice(-6)}` : c.sessionId.slice(0, 8)}
                      <span className="text-subtle ml-1">{c.provider}</span>
                    </td>
                    <td className="py-1 text-right">🧠 {tok(c.contextTokens)}</td>
                    <td className="py-1 text-right text-text">💰 {tok(c.costTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ④ クロスサービス feed (他サービスが push したもの) */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text">
          LLM Cost (cross-service)
          <span className="ml-1 text-subtle font-normal">(全体)</span>
          {feed && !feedEmpty && (
            <span className="ml-2 text-subtle font-normal">
              {usd(feed.total.costUsd)} ({feed.total.calls} calls)
            </span>
          )}
        </h2>
        {feedEmpty ? (
          <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">
            他サービスからの push はまだありません —
            <code className="text-accent mx-1">POST /v1/cost-feed</code>
            に投げると表示されます (Discutere: <code className="text-accent">npm run cost-report</code> + relay)。
          </div>
        ) : (
          feed && (
            <div className="bg-surface border border-border rounded p-4">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-subtle text-xs">
                    <th className="text-left font-normal"></th>
                    <th className="pl-3 text-right font-normal">sess</th>
                    <th className="pl-3 text-right font-normal">calls</th>
                    <th className="pl-3 text-right font-normal">cacheR</th>
                    <th className="pl-3 text-right font-normal">cost</th>
                  </tr>
                </thead>
                <tbody>
                  <FeedRow label="TOTAL" a={feed.total} />
                  {feed.byService.map((a) => (
                    <FeedRow key={"svc:" + a.key} label={"svc: " + a.key} a={a} />
                  ))}
                  {feed.byModel.map((a) => (
                    <FeedRow key={"model:" + a.key} label={"model: " + a.key} a={a} />
                  ))}
                </tbody>
              </table>
              <div className="mt-3 text-subtle text-xs">
                cost は等価 API 換算の推定 (サブスクは定額・実課金ではない)。
              </div>
            </div>
          )
        )}
      </section>
    </div>
  );
}

function carryForward(values: Array<number | null>): number[] {
  let last = 0;
  return values.map((v) => {
    if (v !== null && Number.isFinite(v)) last = v;
    return last;
  });
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    console.info(`[CostFeed] ${label} loaded in ${Math.round(performance.now() - started)}ms`);
  }
}
