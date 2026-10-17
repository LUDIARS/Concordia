import { useEffect, useState } from "react";
import { api, type SessionRow } from "../../api.js";
import { mutate } from "./model.js";

type Target = { id: string; label: string; provider: string; transferMode: "git" | "s3"; ready: boolean };
type Run = { attemptId: string; targetId: string; state: string; receipt: { state: string; remoteId?: string };
  reconciliation: { remoteId: string } | null; verified: { artifacts?: Array<{ name: string }> } | null };
const base = "/v1/delegation/cloud";
const label = (state: string): string => ({ submitted: "送信受付済み", submission_unknown: "受付結果を確認できていません（再送しません）",
  artifacts_verified: "成果物を回収・検査済み（内容の確認は別途必要）",
  review_submitted: "Gitで受領し審査へ提出済み（反映前）",
  review_submission_unconfirmed: "Gitで受領済み・審査受付は未確認（再送しません）" })[state] ?? "確認中";

async function read<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error("状態を取得できませんでした。設定と接続を確認してください。");
  return response.json() as Promise<T>;
}

/** @implements CC-CLOUD-RUNTIME — submission is never presented as completed modelling. */
export function CloudWorkPanel() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [taskReference, setTaskReference] = useState("");
  const [instruction, setInstruction] = useState("");
  const [computeReason, setComputeReason] = useState("");
  const [llmReason, setLlmReason] = useState("");
  const [gpuRequired, setGpuRequired] = useState(false);
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remoteIds, setRemoteIds] = useState<Record<string, string>>({});
  const query = `session_id=${encodeURIComponent(sessionId)}`;
  const unresolved = runs.some(run => run.state === "submission_unknown" && !run.reconciliation);

  useEffect(() => { let cancelled = false; void api.sessions().then(value => {
    if (!cancelled) setSessions(value.sessions.filter(s => s.status !== "ended"));
  }).catch(() => { if (!cancelled) setError("依頼元の一覧を取得できませんでした。"); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setTargets([]); setRuns([]); setTargetId(""); setError("");
    if (sessionId) void Promise.all([read<{ targets: Target[] }>(`${base}/targets?${query}`), read<{ runs: Run[] }>(`${base}/runs?${query}`)])
      .then(([t, r]) => { if (!cancelled) { setTargets(t.targets); setRuns(r.runs); } })
      .catch(() => { if (!cancelled) setError("クラウドの設定や作業一覧を取得できませんでした。"); });
    return () => { cancelled = true; };
  }, [sessionId, query]);

  async function refresh(): Promise<void> { setRuns((await read<{ runs: Run[] }>(`${base}/runs?${query}`)).runs); }
  async function action(path: string, body: unknown): Promise<void> {
    setBusy(true); setError("");
    try {
      const response = await mutate("POST", `${base}${path}`, body);
      if (!response.ok) {
        const detail = await response.json() as { error?: string };
        throw new Error(`処理を完了できませんでした。再送せず状況を確認してください。理由: ${detail.error ?? "確認できません"}`);
      }
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <section className="rounded border border-border bg-surface p-4 space-y-3" aria-label="標準クラウドへの委託">
    <h2 className="font-semibold">標準クラウドへの委託</h2>
    <p className="text-sm text-subtle">50MB以下・環境を準備できる・生成処理が重い・AIの指示が必要な作業が対象です。</p>
    <label className="block">依頼元 <select className="foundation-form" value={sessionId} disabled={busy || locked}
      onChange={e => setSessionId(e.target.value)}><option value="">作業セッションを選ぶ</option>
      {sessions.map(s => <option key={s.id} value={s.id}>{s.repo_path} · {s.id.slice(-8)}</option>)}</select></label>
    {sessionId && targets.length === 0 && <p>このプロジェクトのクラウド環境は未設定です。</p>}
    <label className="block">送信先 <select className="foundation-form" value={targetId} disabled={busy || locked}
      onChange={e => setTargetId(e.target.value)}><option value="">環境を選ぶ</option>
      {targets.map(t => <option key={t.id} value={t.id} disabled={!t.ready}>{t.label} ({t.provider}, {t.transferMode === "s3" ? "S3で受渡し" : "Gitで受領・審査"}){t.ready ? "" : " — 設定の確認が必要"}</option>)}</select></label>
    <label className="block">作業タスクの参照（Actio）<input className="foundation-form w-full" value={taskReference} disabled={locked}
      onChange={e => setTaskReference(e.target.value)} placeholder="actio:..." /></label>
    <label className="block">作ってほしいもの<textarea className="foundation-form w-full" value={instruction} disabled={locked} onChange={e => setInstruction(e.target.value)} /></label>
    <label className="block">処理が重い理由<input className="foundation-form w-full" value={computeReason} disabled={locked} onChange={e => setComputeReason(e.target.value)} /></label>
    <label className="block">AIの判断や操作が必要な理由<input className="foundation-form w-full" value={llmReason} disabled={locked} onChange={e => setLlmReason(e.target.value)} /></label>
    <label className="block"><input type="checkbox" checked={gpuRequired} disabled={locked} onChange={e => setGpuRequired(e.target.checked)} /> GPUが必須（利用できると確認済みの環境のみ）</label>
    {unresolved && <p>受付結果が不明な依頼があります。提供元で確認してから次の依頼へ進んでください。</p>}
    <button className="foundation-form" disabled={busy || locked || unresolved || !targetId || !taskReference || !instruction.trim() || !computeReason.trim() || !llmReason.trim()}
      onClick={() => { setLocked(true); void action("/runs", { session_id: sessionId, attemptId, targetId, taskReference, instruction, computeReason, llmReason, gpuRequired }); }}>クラウドへ依頼する</button>
    {locked && <p className="text-sm">依頼番号: {attemptId}。応答が途切れても、この依頼を再送しません。</p>}
    <button className="foundation-form" disabled={busy || !sessionId} onClick={() => { void refresh().catch(() => setError("状況を取得できませんでした。")); }}>状況を確認</button>
    {locked && runs.some(r => r.attemptId === attemptId && ["artifacts_verified", "review_submitted"].includes(r.state)) && <button className="foundation-form" onClick={() => {
      setAttemptId(crypto.randomUUID()); setLocked(false); setInstruction("");
    }}>次の依頼を作る</button>}
    {error && <p role="alert">{error}</p>}
    {runs.map(run => <article key={run.attemptId} className="border-t border-border pt-3 space-y-2">
      <p>{run.targetId} · {run.attemptId} — {label(run.state)}</p>
      {(run.receipt.remoteId || run.reconciliation?.remoteId) && <p>クラウド側の参照: {run.receipt.remoteId ?? run.reconciliation?.remoteId}</p>}
      <button className="foundation-form" disabled={busy || !!run.verified} onClick={() => void action(`/runs/${run.attemptId}/collect`, { session_id: sessionId })}>成果物を回収する</button>
      {run.state === "submission_unknown" && !run.reconciliation && <div>
        <label>提供元で確認した作業ID<input className="foundation-form" value={remoteIds[run.attemptId] ?? ""} onChange={e => setRemoteIds({ ...remoteIds, [run.attemptId]: e.target.value })} /></label>
        <button disabled={busy || !remoteIds[run.attemptId]} onClick={() => void action(`/runs/${run.attemptId}/reconcile`, { session_id: sessionId, remoteId: remoteIds[run.attemptId] })}>確認した参照を記録（再送なし）</button>
      </div>}
      {run.verified?.artifacts?.map(a => <a key={a.name} className="block underline" href={`${base}/runs/${run.attemptId}/artifacts/${encodeURIComponent(a.name)}?${query}`}>{a.name} を保存</a>)}
    </article>)}
  </section>;
}
