/**
 * /cost — Concordia 自身のセッションコスト + クロスサービス feed。
 *
 * 上段: Discord の「Concordia Monitor」「コスト」チャンネルと同じ内容を WebUI でも詳細表示。
 *   - 本社/子会社別 (本日・週間) トークン
 *   - チャンネル (セッション) 別の現在の 🧠 コンテキスト占有 / 💰 累積コスト
 *   - 10 分毎サンプルの時系列グラフ (使用量 / コンテキスト / セッション数)
 * 下段: 他サービス (Discutere 等) が POST /v1/cost-feed で push した横断コスト。
 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  type CostFeedReport,
  type CostAgg,
  type CostOverview,
  type UsageTimeseries,
  type OrgCostReport,
} from "../api.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";

const usd = (v: number) => "$" + (Number(v) || 0).toFixed(4);
const n = (v: number) => (Number(v) || 0).toLocaleString();
const tok = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return "—";
  const x = Math.max(0, Math.floor(v));
  if (x < 1000) return String(x);
  if (x < 1_000_000) return (x / 1000).toFixed(1) + "k";
  return (x / 1_000_000).toFixed(2) + "M";
};

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
  const [overview, setOverview] = useState<CostOverview | null>(null);
  const [series, setSeries] = useState<UsageTimeseries | null>(null);
  const [feed, setFeed] = useState<CostFeedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, ts, fd] = await Promise.all([
        api.costOverview(),
        api.costTimeseries({ bucketSec: 600 }),
        api.costFeed().catch(() => null),
      ]);
      setOverview(ov);
      setSeries(ts);
      setFeed(fd);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const feedEmpty = !feed || feed.total.calls === 0;
  const points = series?.points ?? [];
  const xLabels = points.map((p) =>
    new Date(p.ts * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
  );

  return (
    <div className="max-w-3xl space-y-6">
      <header className="flex items-center gap-3">
        <h1 className="font-semibold">Cost</h1>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto text-xs px-2 py-1 rounded border border-border text-subtle hover:text-text disabled:opacity-50"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </header>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      {/* ① 本社/子会社別 (本日・週間) */}
      {overview && (
        <section className="bg-surface border border-border rounded p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text">本社 / 子会社別 (トークン)</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <OrgBlock report={overview.windows.daily} heading="本日" />
            <OrgBlock report={overview.windows.weekly} heading="週間" />
          </div>
        </section>
      )}

      {/* ② 時系列グラフ */}
      <section className="bg-surface border border-border rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold text-text">使用量の推移 (10 分毎)</h2>
        <TimeSeriesChart
          xLabels={xLabels}
          series={[
            { label: "💰 消費/10分", color: "#f59e0b", values: points.map((p) => p.spentTokens), fmt: tok },
            { label: "🧠 コンテキスト", color: "#38bdf8", values: points.map((p) => p.contextTokens), fmt: tok },
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
          {overview.channels.length === 0 ? (
            <div className="text-subtle text-sm">アクティブセッションはありません。</div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <tbody>
                {overview.channels.map((c) => (
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
