/**
 * チーム詳細タブ「コストグラフ」。 GET /v1/teams/:id/cost (cost_usage_samples の
 * チーム畳み込み) を折れ線で描く。 当日合計はカードメトリクスと同じ値を出す。
 */

import { useEffect, useState } from "react";
import { api, type TeamCostSeries, type TeamMetrics } from "../../api.js";
import { TimeSeriesChart } from "../../components/TimeSeriesChart.js";
import { fmtTokensShort } from "./model.js";

export function TeamCost({ teamId, metrics }: { teamId: string; metrics?: TeamMetrics }) {
  const [series, setSeries] = useState<TeamCostSeries | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSeries(null);
    setError(null);
    void api.teamCost(teamId, { bucketSec: 3600 })
      .then((result) => { if (!cancelled) setSeries(result); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [teamId]);

  if (error) return <div className="text-danger text-sm">load error: {error}</div>;
  if (!series) return <div className="text-subtle text-sm">loading…</div>;
  return (
    <div className="space-y-3">
      {metrics && (
        <div className="text-sm">
          本日の消費: <span className="font-semibold">{fmtTokensShort(metrics.today_cost_tokens)}</span> tokens
        </div>
      )}
      {series.points.length === 0 ? (
        <div className="text-subtle text-sm">コストサンプルはまだありません (10 分毎サンプラの記録が対象)。</div>
      ) : (
        <TimeSeriesChart
          xLabels={series.points.map((point) =>
            new Date(point.ts * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", hour12: false }),
          )}
          series={[{
            label: "💰 消費/時",
            color: "#f59e0b",
            values: series.points.map((point) => point.cost_tokens),
            fmt: (value) => fmtTokensShort(value ?? 0),
          }]}
          height={200}
        />
      )}
    </div>
  );
}
