import { useCallback, useEffect, useState } from "react";

/** CDGD マネジメント層の人間の管理面 (spec/feature/cdgd-management.md CC-MGMT-06)。 */

interface Mission {
  id: string; name: string; project_codes: string[]; goal: string; allowed_kinds: string[];
  human_gate_kinds: string[]; requires_effect_check: boolean; max_open_requests: number;
  daily_request_limit: number; status: "active" | "stopped";
}
type Action = "approve" | "reject" | "accept" | "effect_confirmed" | "effect_not_met";
interface Request {
  id: string; mission_name: string; request_key: string; kind: string; project_code: string; target_key: string;
  purpose: string; completion_criteria: string; state: string; session_id: string | null;
  outcome_summary: string | null; outcome_refs: string[]; error: string | null; actions: Action[];
}

const STATE_LABELS: Record<string, string> = {
  waiting_human: "人間の判断待ち", rejected: "却下", queued: "起動待ち", launching: "起動中・登録待ち",
  launch_unknown: "起動結果不明・照合中", launch_failed: "起動失敗", attached: "既存依頼へ合流", dispatched: "作業中",
  execution_finished: "セッション終了・成果未記録", outcome_recorded: "成果記録済み・受入待ち", accepted: "受入済み",
  effect_confirmed: "効果あり", effect_not_met: "効果なし",
};
const ACTION_LABELS: Record<Action, string> = {
  approve: "承認", reject: "却下", accept: "受入", effect_confirmed: "効果あり", effect_not_met: "効果なし",
};

async function call<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/v1/admin/management${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(result.message ?? result.error ?? `HTTP ${response.status}`);
  return result;
}

const list = (text: string): string[] => text.split(",").map((v) => v.trim()).filter(Boolean);

export function Management() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [error, setError] = useState("");
  const [token, setToken] = useState<{ mission: string; value: string } | null>(null);
  const [actor, setActor] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "CDGD", project_codes: "", goal: "", allowed_kinds: "discussion, investigation", human_gate_kinds: "spec_change", requires_effect_check: true });

  const refresh = useCallback(async () => {
    try {
      const [m, r] = await Promise.all([call<{ missions: Mission[] }>("/missions"), call<{ requests: Request[] }>("/requests")]);
      setMissions(m.missions); setRequests(r.requests);
    } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const showToken = (mission: Mission, value: string) => setToken({ mission: mission.name, value });

  return <div className="max-w-5xl mx-auto space-y-6">
    <div>
      <h1 className="text-xl font-semibold">CDGD マネジメント</h1>
      <p className="text-sm text-subtle mt-2">dots に任せる任務と、dots が出した依頼の承認・受入・効果確認を行います。dots の依頼は AI の判断であり、ここでの操作だけが人間の判断として記録されます。</p>
    </div>
    {error && <p role="alert" className="text-red-400 whitespace-pre-wrap">{error}</p>}
    {token && <div role="status" className="border border-yellow-500 rounded p-3 space-y-1">
      <p className="text-sm">任務「{token.mission}」のトークンです。この画面を離れると再表示できません。dots の接続先 (CONCORDIA_MANAGEMENT_TOKEN) に設定してください。</p>
      <code className="block break-all text-sm">{token.value}</code>
      <button className="text-sm underline" onClick={() => setToken(null)}>閉じる</button>
    </div>}

    <section className="space-y-3">
      <h2 className="font-semibold">任務</h2>
      {missions.length === 0 && <p className="text-subtle text-sm">任務はまだありません。</p>}
      {missions.map((m) => <article key={m.id} className="border border-border rounded p-3 space-y-2">
        <div className="flex justify-between gap-2"><strong>{m.name}</strong><span className="text-sm">{m.status === "active" ? "稼働中" : "停止中"}</span></div>
        <p className="text-sm whitespace-pre-wrap">{m.goal}</p>
        <p className="text-xs text-subtle">対象: {m.project_codes.join(", ")} / 依頼可: {m.allowed_kinds.join(", ") || "なし"} / 人間判断: {m.human_gate_kinds.join(", ") || "なし"} / 同時 {m.max_open_requests}・日次 {m.daily_request_limit}{m.requires_effect_check ? " / 効果確認あり" : ""}</p>
        <div className="flex gap-2">
          <button disabled={busy} className="border border-border rounded px-3 py-1 text-sm" onClick={() => void run(async () => {
            await call(`/missions/${m.id}/${m.status === "active" ? "stop" : "resume"}`, "POST");
          })}>{m.status === "active" ? "停止" : "再開"}</button>
          <button disabled={busy} className="border border-border rounded px-3 py-1 text-sm" onClick={() => void run(async () => {
            const r = await call<{ token: string }>(`/missions/${m.id}/token`, "POST"); showToken(m, r.token);
          })}>トークン再発行</button>
        </div>
      </article>)}
      <form className="border border-border rounded p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const r = await call<{ mission: Mission; token: string }>("/missions", "POST", {
          name: form.name, project_codes: list(form.project_codes), goal: form.goal,
          allowed_kinds: list(form.allowed_kinds), human_gate_kinds: list(form.human_gate_kinds), requires_effect_check: form.requires_effect_check,
        });
        showToken(r.mission, r.token);
      }); }}>
        <h3 className="text-sm font-semibold">任務を作る</h3>
        <label className="block text-sm">名前<input aria-label="任務名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="block w-full mt-1 rounded border border-border bg-surface p-2" /></label>
        <label className="block text-sm">対象プロジェクト (Cf のコード、カンマ区切り)<input aria-label="対象プロジェクト" value={form.project_codes} onChange={(e) => setForm({ ...form, project_codes: e.target.value })} className="block w-full mt-1 rounded border border-border bg-surface p-2" /></label>
        <label className="block text-sm">目標<textarea aria-label="目標" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} rows={3} className="block w-full mt-1 rounded border border-border bg-surface p-2" /></label>
        <label className="block text-sm">dots が直接依頼できる種別<input aria-label="依頼できる種別" value={form.allowed_kinds} onChange={(e) => setForm({ ...form, allowed_kinds: e.target.value })} className="block w-full mt-1 rounded border border-border bg-surface p-2" /></label>
        <label className="block text-sm">人間の承認が要る種別<input aria-label="人間判断の種別" value={form.human_gate_kinds} onChange={(e) => setForm({ ...form, human_gate_kinds: e.target.value })} className="block w-full mt-1 rounded border border-border bg-surface p-2" /></label>
        <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={form.requires_effect_check} onChange={(e) => setForm({ ...form, requires_effect_check: e.target.checked })} />受入後に効果確認をする</label>
        <button disabled={busy || !form.goal.trim() || !form.project_codes.trim()} className="px-4 py-2 rounded bg-accent text-white disabled:opacity-50">作成</button>
      </form>
    </section>

    <section className="space-y-3">
      <div className="flex justify-between items-end gap-3">
        <h2 className="font-semibold">依頼</h2>
        <label className="text-sm">操作者名<input aria-label="操作者名" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="例: neco" className="ml-2 rounded border border-border bg-surface p-1" /></label>
      </div>
      {requests.length === 0 && <p className="text-subtle text-sm">依頼はまだありません。</p>}
      {requests.map((r) => <article key={r.id} className="border border-border rounded p-3 space-y-1">
        <div className="flex justify-between gap-2"><strong>{STATE_LABELS[r.state] ?? r.state}</strong><span className="text-xs text-subtle">{r.mission_name} · {r.request_key}</span></div>
        <p className="text-sm">{r.kind} / {r.project_code} {r.target_key}</p>
        <p className="text-sm whitespace-pre-wrap">目的: {r.purpose}</p>
        <p className="text-sm whitespace-pre-wrap">完了条件: {r.completion_criteria}</p>
        {r.outcome_summary && <p className="text-sm whitespace-pre-wrap">成果: {r.outcome_summary}</p>}
        {r.outcome_refs.length > 0 && <p className="text-xs break-all">参照: {r.outcome_refs.join(" / ")}</p>}
        {r.error && <p className="text-sm text-red-400">{r.error}</p>}
        {r.actions.length > 0 && <div className="flex gap-2 pt-1">
          {r.actions.map((action) => <button key={action} disabled={busy || !actor.trim()} className="border border-border rounded px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => void run(async () => { await call(`/requests/${r.id}/${action}`, "POST", { actor: `web:${actor.trim()}` }); })}>{ACTION_LABELS[action]}</button>)}
        </div>}
      </article>)}
    </section>
  </div>;
}
