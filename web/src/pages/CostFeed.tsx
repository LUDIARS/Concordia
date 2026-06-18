/**
 * クロスサービス LLM コストパネル (Anatomia の「LLM Cost (cross-service)」を複製)。
 *
 * 送信元サービス (Discutere 等) は同じコスト要約を Anatomia と Concordia の両方へ
 * push しうる。ここでは GET /v1/cost-feed の集計を TOTAL / service 別 / model 別で
 * 並べる。cost は等価 API 換算の推定 (サブスクは定額・実課金ではない)。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type CostFeedReport, type CostAgg } from "../api.js";

const usd = (n: number) => "$" + (Number(n) || 0).toFixed(4);
const n = (v: number) => (Number(v) || 0).toLocaleString();

function Row({ label, a }: { label: string; a: CostAgg }) {
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
  const [report, setReport] = useState<CostFeedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.costFeed());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = !report || report.total.calls === 0;

  return (
    <div className="max-w-3xl space-y-4">
      <header className="flex items-center gap-3">
        <h1 className="font-semibold">LLM Cost (cross-service)</h1>
        {report && !empty && (
          <span className="font-semibold text-text">
            {usd(report.total.costUsd)} ({report.total.calls} calls)
          </span>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto text-xs px-2 py-1 rounded border border-border text-subtle hover:text-text disabled:opacity-50"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </header>

      <p className="text-subtle text-sm">
        各サービス (Discutere 等) が <code className="text-accent">POST /v1/cost-feed</code> で push した
        セッション別コスト要約の横断集計です。Anatomia の同名パネルと同じデータを表示します
        (送信元は両方へ push しうる)。
      </p>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      {empty && !error && (
        <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">
          まだコストが push されていません — サービスが
          <code className="text-accent mx-1">POST /v1/cost-feed</code>
          に投げると表示されます (Discutere: <code className="text-accent">npm run cost-report</code> + relay)。
        </div>
      )}

      {report && !empty && (
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
              <Row label="TOTAL" a={report.total} />
              {report.byService.map((a) => (
                <Row key={"svc:" + a.key} label={"svc: " + a.key} a={a} />
              ))}
              {report.byModel.map((a) => (
                <Row key={"model:" + a.key} label={"model: " + a.key} a={a} />
              ))}
            </tbody>
          </table>

          <div className="mt-3 text-subtle text-xs">
            tokens in/out: {n(report.total.inputTokens)}/{n(report.total.outputTokens)} · cache
            read/create: {n(report.total.cacheReadTokens)}/{n(report.total.cacheCreationTokens)}
            {report.updatedAt
              ? " · updated " + new Date(report.updatedAt).toLocaleString("ja-JP", { hour12: false })
              : ""}
            <br />
            cost は等価 API 換算の推定 (サブスクは定額・実課金ではない)。
          </div>
        </div>
      )}
    </div>
  );
}
