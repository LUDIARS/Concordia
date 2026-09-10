// @spec ハーネス信頼性の実装境界
import { useState } from "react";
import { useLiveQuery } from "../../hooks/useWsEvent.js";

interface Observation { at: number; status: string; reason: string }
interface HarnessStatus {
  configured: { ddd: boolean | null; work_contract: boolean | null; tests_required: boolean | null; ontime_tests_required: boolean | null; classifier: boolean; guidance_revision: string };
  observations: Record<string, Observation>;
  mcp: Record<string, Observation>;
  checkpoint: { id: string; at: number } | null;
  samples: { id: string; stage: string; status: string; advice?: string; model: string | null }[];
  report: { status: string; text?: string } | null;
  coverage: string;
  ontime: { since: number; contracts: { contract: string; marker: string; observed: number; violations: number; predicate_errors: number }[] };
}

async function request<T>(sessionId: string, suffix: string, method = "GET"): Promise<T> {
  const response = await fetch(`/v1/harness/reliability/${encodeURIComponent(sessionId)}/${suffix}`, { method });
  if (!response.ok) throw new Error(`取得・生成に失敗しました (${response.status})`);
  return response.json() as Promise<T>;
}

/** Actual observations are separate from project configuration. */
export function SessionHarnessPanel({ sessionId }: { sessionId: string }) {
  const status = useLiveQuery(() => request<HarnessStatus>(sessionId, "status"), ["hello", "session.event"], sessionId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const labels: Record<string, string> = { compaction: "コンパクション", completion: "Augur完了証跡", mcp_auth: "MCP認証", mcp_injection: "MCP応答の助言", guidance: "公式プロンプト指針", official_config: "公式設定の整合性", prompt_source: "入力の出所" };
  labels.workflow_guidance = "推奨スキル・調査先（案内の記録）";
  labels.notification = "通知受付";
  labels.tool_retry = "ツールの連続失敗";
  labels.mutation_result = "外部更新の結果不明";
  for (const name of ["praeforma", "pf", "anatomia", "an", "actio", "memoria"]) labels[`tool_use_${name}`] = `${name} の利用観測`;
  const generate = async () => {
    setBusy(true); setMessage("");
    try {
      await request(sessionId, "approach", "POST");
      setMessage("SYSTEM投稿を受け付けました。Discordへの配送は未確認です。");
    } catch (error) { setMessage((error as Error).message + "。標本不足・生成中・生成上限を確認してください。"); }
    finally { setBusy(false); status.refetch(); }
  };
  return <section className="mt-4 space-y-2 text-sm" aria-label="ハーネス適用状況">
    <div className="flex items-center justify-between"><h3 className="font-semibold">ハーネス適用状況</h3><button type="button" className="text-accent" onClick={status.refetch}>更新</button></div>
    {status.error && <p role="alert">{status.error.message}</p>}
    {!status.data && !status.error && <p>読み込み中...</p>}
    {status.data && <>
      <p className="text-subtle">{status.data.coverage}</p>
      <p>設定: DDD {configured(status.data.configured.ddd)} / 作業契約 {configured(status.data.configured.work_contract)}</p>
      <p>実装必須: テスト {configured(status.data.configured.tests_required)} / オンタイム {configured(status.data.configured.ontime_tests_required)}</p>
      <a className="text-accent" target="_blank" rel="noreferrer" href={`/v1/harness/reliability/${encodeURIComponent(sessionId)}/acceptance`}>コードの受入条件と証跡を確認（実行結果は別）</a>
      <p className="text-subtle">作業契約の設定とAugurの受入条件検証は別です。</p>
      <div className="rounded border border-border p-2"><p>オンタイム契約観測（Ccプロセス全体）</p>
        <p className="text-xs text-subtle">{new Date(status.data.ontime.since).toLocaleString()} 以降。再起動で表示件数はリセット。期間別の受入証跡はAugurのログ集計を使用。</p>
        {!status.data.ontime.contracts.length && <p>未観測</p>}
        {status.data.ontime.contracts.map(item => <p key={`${item.contract}:${item.marker}`} className="text-xs">{item.contract}: 条件充足 {item.observed} / 違反 {item.violations} / 述語例外 {item.predicate_errors}</p>)}
      </div>
      {Object.entries(labels).map(([key, label]) => {
        const observation = status.data!.observations[key];
        return <div key={key} className="rounded border border-border p-2"><p>{label}: {observation?.status ?? "未観測"}</p>
          <p className="break-words text-xs text-subtle">{observation ? `${new Date(observation.at).toLocaleString()} · ${observation.reason}` : "対応フックからの実行記録がありません"}</p></div>;
      })}
      {Object.entries(status.data.mcp).map(([tool, observation]) => <p key={tool} className="break-words text-xs">{tool}: {observation.status} · {new Date(observation.at).toLocaleString()}</p>)}
      {status.data.checkpoint && <a className="text-accent" target="_blank" rel="noreferrer" href={`/v1/harness/reliability/${encodeURIComponent(sessionId)}/checkpoint`}>保存済み引継ぎを開く</a>}
      <p>プロンプト標本: {status.data.samples.length} 件 / 公式資料確認日 {status.data.configured.guidance_revision}</p>
      {status.data.samples.slice(-3).map((sample) => <div key={sample.id} className="rounded border border-border p-2"><p>{sample.stage === "initial" ? "初動" : "中間"} · {sample.status} · モデル {sample.model ?? "不明"}</p><p className="whitespace-pre-wrap">{sample.advice ?? "評価結果なし"}</p></div>)}
      <button type="button" className="text-accent disabled:opacity-50" disabled={busy || !status.data.samples.length || !status.data.configured.classifier} onClick={() => void generate()}>{busy ? "生成中..." : "このセッションのプロンプトアプローチを生成してSYSTEMへ投稿"}</button>
      {message && <p role="status">{message}</p>}
      {status.data.report && <p className="whitespace-pre-wrap">{status.data.report.status}\n{status.data.report.text}</p>}
    </>}
  </section>;
}

function configured(value: boolean | null): string { return value === null ? "不明" : value ? "有効" : "無効"; }
