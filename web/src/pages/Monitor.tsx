import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../api.js";
import type { SessionRow, DelegationTemplateLite } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

export function Monitor() {
  const { data, error } = useLiveQuery(
    () => api.monitor(),
    [
      "session.started",
      "session.ended",
      "session.lost",
      "session.event",
      "persona.assigned",
      "persona.released",
    ],
  );

  // 各 session の最新 stat (10 分毎の poll 結果). フラットチームの相互状況把握用.
  const stats = useLiveQuery(() => api.statList(), ["stat.collected"]);
  const statByIdx = new Map<string, { latest_ts: number; payload: Record<string, unknown> }>();
  for (const it of stats.data?.items ?? []) {
    statByIdx.set(it.session_id, { latest_ts: it.latest_ts, payload: it.payload });
  }

  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  // 同 repo の active session が複数いるものを「競合」 として抽出
  const conflictRepos = data.repos.filter((r) => r.count >= 2);
  const conflictSessionsByRepo = new Map<string, SessionRow[]>();
  for (const r of conflictRepos) {
    conflictSessionsByRepo.set(
      r.key,
      data.active.filter((s) => (s.repo_origin ?? s.repo_path) === r.key),
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-base font-semibold mb-2">
          repos <span className="text-subtle text-xs ml-2">{data.repos.length}</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {data.repos.length === 0 && (
            <span className="text-subtle text-sm">no active session</span>
          )}
          {data.repos.map((r) => {
            const conflict = r.count >= 2;
            return (
              <span
                key={r.key}
                className={`px-2 py-1 border rounded text-xs ${
                  conflict
                    ? "bg-warning/10 border-warning text-warning"
                    : "bg-muted border-border"
                }`}
                title={conflict ? "複数 active session が同一 repo で作業中" : undefined}
              >
                {r.key}
                <span className={`ml-2 ${conflict ? "font-bold" : "text-accent"}`}>×{r.count}</span>
              </span>
            );
          })}
        </div>
      </section>

      {conflictRepos.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-2">
            ⚠ conflicts <span className="text-subtle text-xs ml-2">{conflictRepos.length}</span>
          </h2>
          <div className="space-y-2">
            {conflictRepos.map((r) => (
              <div
                key={r.key}
                className="bg-warning/5 border border-warning/40 rounded p-3 text-sm"
              >
                <div className="font-mono text-xs text-subtle mb-2">{r.key}</div>
                <div className="flex flex-wrap gap-2">
                  {(conflictSessionsByRepo.get(r.key) ?? []).map((s) => (
                    <Link
                      key={s.id}
                      to={`/sessions/${encodeURIComponent(s.id)}`}
                      className="px-2 py-1 bg-surface border border-border rounded text-xs hover:border-accent"
                    >
                      <span className="text-accent">{s.branch ?? "(no branch)"}</span>
                      <span className="ml-2 text-subtle">
                        {((s.metadata as any)?.role_label ?? "雑用係")} / {s.id.slice(0, 8)}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <MachinesSection />
      <SpawnSessionForm />

      <SessionList title="active" rows={data.active} statByIdx={statByIdx} />
      <SessionList title="lost" rows={data.lost} statByIdx={statByIdx} />
      <SessionList title="recently ended" rows={data.recent_ended} statByIdx={statByIdx} />
    </div>
  );
}

/**
 * Machines overview — aggregated active/lost/ended counts per host. Refreshes
 * on session.started / session.ended events so spawn + stop actions are
 * reflected without manual reload.
 */
function MachinesSection() {
  const { data } = useLiveQuery(() => api.machinesList(), [
    "session.started",
    "session.ended",
    "session.lost",
  ]);
  if (!data || data.machines.length === 0) return null;
  return (
    <section>
      <h2 className="text-base font-semibold mb-2">
        machines <span className="text-subtle text-xs ml-2">{data.machines.length}</span>
      </h2>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
      >
        {data.machines.map((m) => (
          <div key={m.host} className="bg-surface border border-border rounded p-3">
            <div className="font-mono text-sm">{m.host}</div>
            <div className="mt-2 flex items-center gap-3 text-xs">
              <span className="text-ok">active {m.active}</span>
              {m.lost > 0 && <span className="text-warn">lost {m.lost}</span>}
              <span className="text-subtle">ended {m.ended}</span>
              <span className="ml-auto text-subtle">{fmtTs(m.last_seen_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Spawn a new lictor-wrapped agent via /v1/admin/spawn-session.
 * Windows-only today (the spawner requires wt.exe).
 *
 * 起動は delegation テンプレ選択ベース (provider 直接選択は廃止):
 *   - provider / model / 既定 cwd はテンプレから採用する。
 *     model はテンプレの `--model` 値 (空なら provider CLI の config 既定)。
 *   - 「プロンプトを注入」 ON で、 テンプレを render したプロンプトを起動直後に
 *     自動注入する (= delegation invoke 相当)。 OFF なら provider+model だけの
 *     素のセッション。 注入時のみ input_schema の引数欄を出す。
 *   - title: Lictor の auto-title が起動直後に上書きするので入力しない。
 * 同じパラメータは API (/v1/admin/spawn-session) でも叩ける。
 */
function SpawnSessionForm() {
  const [templates, setTemplates] = useState<DelegationTemplateLite[]>([]);
  const [callName, setCallName] = useState<string>("");
  const [mode, setMode] = useState<"tab" | "window">("tab");
  const [injectPrompt, setInjectPrompt] = useState(false);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [cwd, setCwd] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    api.delegationTemplates()
      .then((r) => {
        const spawnable = r.templates.filter((t) => !t.call_only);
        setTemplates(spawnable);
        if (spawnable.length > 0) setCallName((cur) => cur || spawnable[0].call_name);
      })
      .catch(() => { /* テンプレ未取得でもフォーム自体は出す */ });
  }, []);

  const selected = templates.find((t) => t.call_name === callName) ?? null;

  // テンプレ切替時に arg 入力欄を default で初期化、 cwd override はクリア
  // (空なら backend がテンプレの default_cwd を使う)。
  useEffect(() => {
    if (!selected) { setArgs({}); setCwd(""); return; }
    const init: Record<string, string> = {};
    for (const s of selected.input_schema) {
      init[s.name] = s.default !== undefined ? String(s.default) : "";
    }
    setArgs(init);
    setCwd("");
  }, [callName]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending || !selected) return;
    setSending(true);
    setResult(null);
    try {
      const body: Parameters<typeof api.adminSpawn>[0] = {
        template: selected.call_name,
        inject_prompt: injectPrompt,
        mode,
      };
      if (injectPrompt) {
        const a: Record<string, unknown> = {};
        for (const s of selected.input_schema) {
          const v = args[s.name];
          if (v === undefined || v === "") continue;
          if (s.type === "number") a[s.name] = Number(v);
          else if (s.type === "boolean") a[s.name] = v === "true";
          else a[s.name] = v;
        }
        body.args = a;
      }
      if (cwd.trim()) body.cwd = cwd.trim();
      const r = await api.adminSpawn(body);
      setResult({
        ok: true,
        msg: `spawned (pid=${r.pid ?? "?"}${r.injected_prompt ? ", prompt 注入" : ""})`,
      });
    } catch (err) {
      setResult({ ok: false, msg: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-surface border border-border rounded p-4 space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">新規セッション</h2>
        <span className="text-xs text-subtle">
          delegation テンプレを選んで lictor wrapped agent を起動 (provider/model はテンプレ由来)
        </span>
      </div>
      {templates.length === 0 ? (
        <div className="text-xs text-subtle">
          有効な delegation テンプレがありません。{" "}
          <Link to="/delegation" className="text-accent">Delegation</Link> で作成してください。
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={callName}
              onChange={(e) => setCallName(e.target.value)}
              disabled={sending}
              className="foundation-form text-sm"
              title="delegation テンプレ — provider / model / 既定 cwd を継承"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.call_name}>{t.title} ({t.call_name})</option>
              ))}
            </select>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "tab" | "window")}
              disabled={sending}
              className="foundation-form text-sm"
              title="tab = 同じ Windows Terminal 内、 window = 新規ウインドウ"
            >
              <option value="tab">tab</option>
              <option value="window">window</option>
            </select>
            <label className="text-xs text-subtle flex items-center gap-1" title="テンプレの prompt を render して起動直後に注入する">
              <input
                type="checkbox"
                checked={injectPrompt}
                onChange={(e) => setInjectPrompt(e.target.checked)}
                disabled={sending}
              />
              プロンプトを注入
            </label>
            <button
              type="submit"
              disabled={sending || !selected}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
            >
              {sending ? "起動中…" : "起動"}
            </button>
          </div>
          {selected && (
            <div className="text-xs text-subtle">
              provider: <code>{selected.target_provider}</code>
              {" / "}model: <code>{selected.model ?? "(provider 既定)"}</code>
            </div>
          )}
          {injectPrompt && selected && selected.input_schema.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {selected.input_schema.map((s) => (
                <label key={s.name} className="text-xs space-y-1">
                  <span className="text-subtle">
                    {s.name} <span className="font-mono">{s.type}</span>
                    {s.required && <span className="text-danger"> *</span>}
                  </span>
                  <input
                    className="foundation-form w-full text-sm"
                    value={args[s.name] ?? ""}
                    onChange={(e) => setArgs({ ...args, [s.name]: e.target.value })}
                    disabled={sending}
                  />
                </label>
              ))}
            </div>
          )}
          {injectPrompt && (
            <label className="text-xs space-y-1 block">
              <span className="text-subtle">cwd (任意 override — 空ならテンプレ既定)</span>
              <input
                className="foundation-form w-full text-sm"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                disabled={sending}
                placeholder={selected?.default_cwd ?? ""}
              />
            </label>
          )}
        </>
      )}
      {result && (
        <div className={`text-xs ${result.ok ? "text-ok" : "text-danger"}`}>{result.msg}</div>
      )}
    </form>
  );
}

function SessionList({
  title,
  rows,
  statByIdx,
}: {
  title: string;
  rows: SessionRow[];
  statByIdx: Map<string, { latest_ts: number; payload: Record<string, unknown> }>;
}) {
  if (rows.length === 0) return null;
  // 更新が新しい順 (last_seen_at 降順) に並べる. 同値は id で安定ソート.
  const sorted = [...rows].sort(
    (a, b) => b.last_seen_at - a.last_seen_at || a.id.localeCompare(b.id),
  );
  return (
    <section>
      <h2 className="text-base font-semibold mb-2 capitalize">
        {title} <span className="text-subtle text-xs ml-2">{rows.length}</span>
      </h2>
      {/* 画面幅いっぱいに入るだけカードを敷き詰める (auto-fill). */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
      >
        {sorted.map((s) => (
          <SessionCard key={s.id} s={s} stat={statByIdx.get(s.id)} />
        ))}
      </div>
    </section>
  );
}

function SessionCard({
  s,
  stat,
}: {
  s: SessionRow;
  stat?: { latest_ts: number; payload: Record<string, unknown> };
}) {
  const role = (s.metadata as any)?.role_label ?? "雑用係";
  // active で lictor_pid を持つ session のみカードから直接 kill できる.
  // SessionDetail にも同じボタンがある (こちらはショートカット).
  const canStop = s.status === "active" && typeof (s.metadata as any)?.lictor_pid === "number";
  return (
    <Link
      to={`/sessions/${encodeURIComponent(s.id)}`}
      className="block bg-surface border border-border rounded p-3 hover:border-accent transition-colors"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded ${statusBadge(s.status)}`}>{s.status}</span>
        <span className="text-subtle">{s.provider}</span>
        <span className="ml-auto text-subtle">{s.id.slice(0, 8)}…</span>
        {canStop && <StopButton sessionId={s.id} />}
      </div>
      <div className="mt-2 text-sm font-mono truncate">{s.repo_path}</div>
      <div className="text-xs">
        <span className="px-1.5 py-0.5 bg-muted rounded font-mono">
          {s.branch ?? "(no branch)"}
        </span>
        <span className="ml-2 text-subtle">@ {s.host}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-accent">{role}</span>
        <span className="ml-auto text-subtle">{fmtTs(s.last_seen_at)}</span>
      </div>
      {s.current_task && (
        <div className="mt-2 text-xs bg-muted px-2 py-1 rounded line-clamp-2">
          {s.current_task}
        </div>
      )}
      {stat && (
        <div className="mt-2 text-[10px] text-subtle border-t border-border pt-1">
          stat: {fmtTs(stat.latest_ts)}
          {typeof stat.payload?.recent_work === "string" && (
            <span className="ml-2 line-clamp-1">{stat.payload.recent_work as string}</span>
          )}
        </div>
      )}
    </Link>
  );
}

/**
 * Inline stop button used inside a Link card. click 時に Link 遷移を止め、
 * confirm → adminStop を叩く. WS の session.ended event でリストは自動更新される.
 */
function StopButton({ sessionId }: { sessionId: string }) {
  const [sending, setSending] = useState(false);
  const click = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (sending) return;
    if (!confirm("このセッションを強制終了しますか? (lictor + claude が即 kill されます)")) return;
    setSending(true);
    try {
      await api.adminStop(sessionId);
    } catch (err) {
      alert(`停止に失敗: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };
  return (
    <button
      type="button"
      onClick={click}
      disabled={sending}
      className="px-1.5 py-0.5 bg-danger/80 hover:bg-danger text-white rounded text-[10px] disabled:opacity-50"
      title="セッションを強制終了 (lictor + claude を即 kill)"
    >
      {sending ? "停止中…" : "停止"}
    </button>
  );
}
