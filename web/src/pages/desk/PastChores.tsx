/**
 * 過去の雑務 (Cc v5)。雑務の新規受付は依頼窓口にまとめた。受付済みの雑務は読み取りと、処理中の run の OK / Continue だけを残す。
 */
import { useEffect, useState } from "react";
import { choresApi, type ChoreView } from "../control/controlApi.js";

const LABELS: Record<string, string> = { queued: "受付済み", running: "実行中", succeeded: "完了・確認待ち", failed: "実行失敗",
  interrupted: "結果不明・要確認", acknowledged: "確認済み", continuing: "継続起動・照合待ち", continued: "継続セッション起動済み" };
const ACTIONS = [
  { action: "ok", label: "OK", className: "border border-border rounded px-4 py-2 disabled:opacity-50" },
  { action: "continue", label: "Continue", className: "bg-accent text-white rounded px-4 py-2 disabled:opacity-50" },
] as const;

export function PastChores() {
  const [runs, setRuns] = useState<ChoreView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    choresApi.list(controller.signal).then((data) => setRuns(data.runs))
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, []);
  return <details className="border border-border rounded p-3" aria-label="過去の雑務">
    <summary className="cursor-pointer font-semibold">過去の雑務 ({runs.length})</summary>
    <div className="space-y-3 mt-3">
      {error && <p role="alert" className="text-red-400 whitespace-pre-wrap">{error}</p>}
      {runs.length === 0 && <p className="text-subtle">過去の雑務はありません。</p>}
      {runs.map((run) => <article key={run.id} className="border border-border rounded p-3 space-y-2">
        <div className="flex justify-between gap-2"><strong>{LABELS[run.status] ?? run.status}</strong><span className="text-subtle text-sm">{run.provider} · {run.id.slice(0, 8)}</span></div>
        <p className="whitespace-pre-wrap break-words">{run.prompt}</p>
        {run.output && <pre className="whitespace-pre-wrap break-words text-sm bg-surface p-3 rounded">{run.output}</pre>}
        {run.error && <p className="whitespace-pre-wrap text-red-400">{run.error}</p>}
        {run.spawn_id && <p className="text-sm break-all">継続起動ID: {run.spawn_id}</p>}
        {(run.status === "succeeded" || run.status === "failed" || run.status === "interrupted") && <div className="flex gap-3">
          {ACTIONS.map((item) => <button key={item.action} className={item.className}
            disabled={busy || (item.action === "continue" && run.status === "interrupted")}
            onClick={() => {
              setBusy(true); setError("");
              void choresApi.choose(run.id, item.action)
                .then(({ run: next }) => setRuns((old) => old.map((r) => (r.id === run.id ? next : r))))
                .catch((e: unknown) => setError(String(e)))
                .finally(() => setBusy(false));
            }}>{item.label}</button>)}
        </div>}
      </article>)}
    </div>
  </details>;
}
