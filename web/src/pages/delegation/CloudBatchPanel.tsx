import { useState } from "react";
import { mutate } from "./model.js";

type Batch = {
  batchId: string; targetId: string; stopped: boolean; finished: boolean; lastError: string | null;
  counts: Record<string, number>;
  shards: Array<{ attemptId: string; phase: string; remoteId: string | null }>;
};
const phaseLabel: Record<string, string> = {
  queued: "待機", unknown: "受付不明", running: "実行中", remote_ready: "提供元で終了",
  remote_error: "提供元で失敗", collected: "回収済み",
};

export function CloudBatchPanel({ sessionId }: { sessionId: string }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<Batch>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const base = "/v1/delegation/cloud/batches";
  const query = new URLSearchParams({ session_id: sessionId });

  async function request(action: () => Promise<Response>, receive: (body: unknown) => void) {
    setError(""); setBusy(true);
    try {
      const response = await action();
      if (!response.ok) throw new Error();
      receive(await response.json());
    } catch { setError("バッチの状態を取得または更新できませんでした。"); }
    finally { setBusy(false); }
  }

  function show(status: Batch) {
    setSelected(status);
    setBatches(items => items.map(batch => batch.batchId === status.batchId ? status : batch));
  }

  return <section aria-label="Codex Cloud バッチ" className="border-t border-border pt-3 space-y-2">
    <h3 className="font-medium">Codex Cloud バッチ</h3>
    <button className="foundation-form" disabled={busy} onClick={() => void request(
      () => fetch(`${base}?${query}`), body => {
        const result = body as { batches: Batch[] };
        setBatches(result.batches);
        setSelected(current => result.batches.find(item => item.batchId === current?.batchId));
      })}>バッチ一覧を更新</button>
    {error && <p role="alert">{error}</p>}
    <ul>
      {batches.map(batch => <li key={batch.batchId} className="flex items-center gap-2">
        <span>{batch.batchId} · {batch.targetId} · {batch.stopped ? "追加投入停止" : batch.finished ? "終了" : "進行中"}</span>
        <button disabled={busy} className="foundation-form" onClick={() => void request(
          () => fetch(`${base}/${encodeURIComponent(batch.batchId)}?${query}`), body => show(body as Batch))}>バッチの詳細</button>
      </li>)}
    </ul>
    {selected && <article aria-label={`バッチ ${selected.batchId} の状態`} className="space-y-2">
      <p>{Object.entries(selected.counts).map(([phase, count]) => `${phaseLabel[phase] ?? phase} ${count} 件`).join(" · ")}</p>
      {selected.lastError && <p role="status">{selected.lastError}</p>}
      <ul>{selected.shards.map(shard => <li key={shard.attemptId}>{shard.attemptId} · {phaseLabel[shard.phase] ?? shard.phase}
        {shard.remoteId ? ` · ${shard.remoteId}` : ""}</li>)}</ul>
      <button disabled={busy || selected.stopped || selected.finished} className="foundation-form"
        onClick={() => void request(() => mutate("POST", `${base}/${encodeURIComponent(selected.batchId)}/stop`,
          { session_id: sessionId }), body => show(body as Batch))}>バッチの追加投入を停止</button>
    </article>}
  </section>;
}
