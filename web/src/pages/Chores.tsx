import { useEffect, useRef, useState } from "react";

interface Chore {
  id: string; prompt: string; provider: "claude" | "codex"; status: string; cwd: string;
  output: string; error: string | null; spawn_id: string | null;
}
const labels: Record<string, string> = { queued: "受付済み", running: "実行中", succeeded: "完了・確認待ち", failed: "実行失敗",
  interrupted: "結果不明・要確認", acknowledged: "確認済み", continuing: "継続起動・照合待ち", continued: "継続セッション起動済み" };
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/v1/chores${path}`, { method: body ? "POST" : "GET", signal,
    headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
export function Chores() {
  const [runs, setRuns] = useState<Chore[]>([]);
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; prompt: string; provider: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || controller.signal.aborted) return;
      refreshing = true;
      try { const data = await request<{ runs: Chore[] }>("", undefined, controller.signal); setRuns(data.runs); }
      catch (e) { if (!controller.signal.aborted) setError(String(e)); }
      finally { refreshing = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const choose = async (id: string, action: "ok" | "continue") => {
    setBusy(true); setError("");
    try { const { run } = await request<{ run: Chore }>(`/${id}/choice`, { action }); setRuns(old => old.map(r => r.id === id ? run : r)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="max-w-4xl mx-auto space-y-5">
    <div><h1 className="text-xl font-semibold">雑務</h1><p className="text-sm text-subtle mt-2">短い依頼を実行します。結果を確認してOK、続きを相談するときはContinueを選んでください。</p></div>
    <form className="space-y-3 rounded border border-border p-4" onSubmit={async e => {
      e.preventDefault(); if (busy) return; setBusy(true); setError("");
      if (!pending.current || pending.current.prompt !== prompt || pending.current.provider !== provider) pending.current = { key: `web:${crypto.randomUUID()}`, prompt, provider };
      try {
        const { run } = await request<{ run: Chore }>("", { request_key: pending.current.key, prompt, provider });
        setRuns(old => [run, ...old.filter(r => r.id !== run.id)]); setPrompt(""); pending.current = null;
      } catch (e) { setError(String(e)); } finally { setBusy(false); }
    }}>
      <label className="block">依頼内容<textarea required maxLength={16000} value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} className="block w-full mt-2 rounded border border-border bg-surface p-2" /></label>
      <div className="flex gap-3 items-center"><label>実行CLI <select aria-label="実行CLI" value={provider} onChange={e => setProvider(e.target.value as "claude" | "codex")} className="bg-surface border border-border rounded p-2"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
      <button disabled={busy || !prompt.trim()} className="px-4 py-2 rounded bg-accent text-white disabled:opacity-50">依頼する</button></div>
    </form>
    {error && <p role="alert" className="text-red-400 whitespace-pre-wrap">{error}</p>}
    {runs.length === 0 && <p className="text-subtle">まだ雑務はありません。</p>}
    {runs.map(run => <article key={run.id} className="border border-border rounded p-4 space-y-3">
      <div className="flex justify-between gap-2"><strong>{labels[run.status] ?? run.status}</strong><span className="text-subtle text-sm">{run.provider} · {run.id.slice(0, 8)}</span></div>
      <p className="whitespace-pre-wrap break-words">{run.prompt}</p>
      {run.output && <pre className="whitespace-pre-wrap break-words text-sm bg-surface p-3 rounded">{run.output}</pre>}
      {run.error && <p className="whitespace-pre-wrap text-red-400">{run.error}</p>}
      <details className="text-xs text-subtle"><summary>作業場所</summary><p className="break-all mt-2">{run.cwd}</p></details>
      {run.spawn_id && <p className="text-sm break-all">継続起動ID: {run.spawn_id}</p>}
      {(run.status === "succeeded" || run.status === "failed" || run.status === "interrupted") && <div className="flex gap-3">
        <button disabled={busy} onClick={() => { void choose(run.id, "ok"); }} className="border border-border rounded px-4 py-2 disabled:opacity-50">OK</button>
        <button disabled={busy || run.status === "interrupted"} onClick={() => { void choose(run.id, "continue"); }} className="bg-accent text-white rounded px-4 py-2 disabled:opacity-50">Continue</button>
      </div>}
    </article>)}
  </div>;
}
