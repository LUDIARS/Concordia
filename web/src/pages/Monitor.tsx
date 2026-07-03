import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../api.js";
import type { SessionRow, DelegationTemplateLite, HostSnapshot, SubsidiarySummary } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";
import { SubsidiaryProjectSpawnForm } from "../components/SubsidiaryProjectSpawnForm.js";

function fmtBytes(b: number | null | undefined): string {
  if (b == null || !isFinite(b)) return "—";
  if (b < 1024) return `${b} B`;
  const mib = b / 1024 ** 2;
  if (mib < 1024) return `${mib.toFixed(0)} MiB`;
  return `${(b / 1024 ** 3).toFixed(2)} GiB`;
}

function optionValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

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

      <SubsidiariesSection active={data.active} />
      <MachinesSection />
      <PerformanceSection />
      <SpawnSessionForm />

      <SessionList title="active" rows={data.active} statByIdx={statByIdx} />
      <SessionList title="lost" rows={data.lost} statByIdx={statByIdx} />
      <SessionList title="recently ended" rows={data.recent_ended} statByIdx={statByIdx} />
    </div>
  );
}

/** トークン数を人が読みやすい桁 (1,234k / 1,234) に整形する。 */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000).toLocaleString("en-US")}k`;
  return n.toLocaleString("en-US");
}

/**
 * 子会社の様子 — 出張先 (別 Discord/Slack) で動く子会社 Bot の稼働状況を Monitor に一覧する。
 * 管理は /subsidiaries に集約されているが、 ここでは「今どの子会社が動いていて、 何件
 * セッションを起こし、 予算をどれだけ使い、 ガードが何件弾いたか」を一目で出す。
 *
 *  - 稼働中セッション数: active セッションを metadata.subsidiary_id で集計 (本社セッションは
 *    subsidiary_id を持たないので自然に除外される)。 親から渡る active は WS で更新されるため
 *    セッション数はライブに反映される。
 *  - 子会社サマリ (running / 予算 / lock / 直近 24h の allow|deny) は WS イベントが無いので
 *    8 秒 poll で取り直す (PC パフォーマンスと同じ方式)。
 * カードクリックで管理ページ (/subsidiaries) へ。
 */
function SubsidiariesSection({ active }: { active: SessionRow[] }) {
  const [subs, setSubs] = useState<SubsidiarySummary[] | null | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    const tick = () =>
      api.subsidiariesList()
        .then((r) => { if (!stopped) setSubs(r.subsidiaries); })
        .catch(() => { if (!stopped) setSubs(null); });
    void tick();
    const id = setInterval(tick, 8000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // subsidiary_id ごとの稼働中セッション数 (本社セッションは subsidiary_id 無しで除外)。
  const activeBySub = new Map<string, number>();
  for (const s of active) {
    const sid = (s.metadata as any)?.subsidiary_id;
    if (typeof sid === "string" && sid) activeBySub.set(sid, (activeBySub.get(sid) ?? 0) + 1);
  }

  if (subs === undefined) return null; // 初回ロード中
  if (subs === null || subs.length === 0) return null; // 未取得 / 未登録は出さない

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-base font-semibold">
          子会社 <span className="text-subtle text-xs ml-2">{subs.length}</span>
        </h2>
        <Link to="/subsidiaries" className="text-xs text-accent ml-auto">管理 →</Link>
      </div>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
      >
        {subs.map((s) => {
          const activeCount = activeBySub.get(s.id) ?? 0;
          const budget = s.daily_token_budget ?? 0;
          const used = s.usage_today_tokens ?? 0;
          const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
          const deny = s.requests_24h?.deny ?? 0;
          const allow = s.requests_24h?.allow ?? 0;
          const locks = s.lock_count ?? 0;
          return (
            <div
              key={s.id}
              className="bg-surface border border-border rounded p-3 hover:border-accent transition-colors"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${s.running ? "bg-ok" : "bg-subtle"}`}
                  title={s.running ? "Bot 稼働中" : "Bot 停止"}
                />
                <span className="text-sm font-medium truncate">{s.display_name || s.name}</span>
                <span className="text-subtle text-xs">/ {s.platform}</span>
                {!s.enabled && <span className="text-[10px] text-subtle ml-auto">無効</span>}
                <Link to="/subsidiaries" className="text-[10px] text-accent ml-auto shrink-0">管理 →</Link>
              </div>

              <div className="mt-2 flex items-center gap-2 text-xs">
                <span className={activeCount > 0 ? "text-accent" : "text-subtle"} title="この子会社が今起こしている active セッション数">
                  セッション {activeCount}
                </span>
                {locks > 0 && <span className="text-warn">🔒 {locks}</span>}
                <span className="ml-auto flex items-center gap-2">
                  {deny > 0 && <span className="text-danger" title="直近 24h に deny した件数">deny {deny}</span>}
                  {allow > 0 && <span className="text-subtle" title="直近 24h に allow した件数">allow {allow}</span>}
                </span>
              </div>

              {/* 当日トークン予算 */}
              <div className="mt-2 text-[11px]">
                <div className="flex items-center gap-1 text-subtle">
                  <span className={s.budget_blocked ? "text-danger" : ""}>
                    {s.budget_blocked ? "💸 " : ""}予算 {fmtTokens(used)}/{budget > 0 ? fmtTokens(budget) : "∞"}
                  </span>
                  {budget > 0 && <span className="ml-auto">{pct}%</span>}
                </div>
                {budget > 0 && (
                  <div className="mt-1 h-1 bg-muted rounded overflow-hidden">
                    <div
                      className={`h-full ${s.budget_blocked || pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-accent"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>

              <SubsidiaryProjectSpawnForm subsidiaryId={s.id} className="mt-2 pt-2 border-t border-border" />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 子会社セッションの spawn フォーム (Monitor 子会社カード内)。
 * project 名を渡すと backend が workspace roots 配下で cwd を解決し、
 * 「project 以外の作業禁止」 の制限プロンプトを注入して spawn する (project 必須)。
 */
function SubsidiarySpawnForm({ subsidiaryId }: { subsidiaryId: string }) {
  const [project, setProject] = useState("");
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function spawn() {
    if (!project.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.adminSpawn({
        provider,
        subsidiary_id: subsidiaryId,
        project: project.trim(),
      });
      setResult(r.ok ? `✅ spawned (pid ${r.pid ?? "?"}) — ${project.trim()} 限定` : `❌ ${r.error ?? "spawn failed"}`);
      if (r.ok) setProject("");
    } catch (err) {
      setResult(`❌ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 pt-2 border-t border-border">
      <div className="flex items-center gap-1">
        <input
          className="foundation-form flex-1 min-w-0 text-xs"
          placeholder="project (例: Pictor)"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void spawn(); }}
        />
        <select
          className="foundation-form text-xs"
          value={provider}
          onChange={(e) => setProvider(e.target.value as "claude" | "codex")}
        >
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
        <button
          onClick={() => void spawn()}
          disabled={busy || !project.trim()}
          className="bg-accent text-bg px-2 py-1 rounded text-xs font-medium disabled:opacity-50 shrink-0"
        >Spawn</button>
      </div>
      <div className="text-[10px] text-subtle mt-1">
        project 配下に cwd 固定 + 範囲外作業を禁止する注入付きで起動
      </div>
      {result && <div className="text-[11px] mt-1">{result}</div>}
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
 * PC パフォーマンス概況 — ホストのメモリ/CPU + 上位プロセス + WSL/docker +
 * セッション別メモリ (並び替え可)。 host_metrics の最新スナップショットを 10 秒 poll。
 */
function PerformanceSection() {
  const [snap, setSnap] = useState<HostSnapshot | null | undefined>(undefined);
  const [sortKey, setSortKey] = useState<"rss" | "label">("rss");

  useEffect(() => {
    let stopped = false;
    const tick = () =>
      api.metrics()
        .then((r) => { if (!stopped) setSnap(r.snapshot); })
        .catch(() => { if (!stopped) setSnap(null); });
    void tick();
    const id = setInterval(tick, 10000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  if (snap === undefined) return null; // 初回ロード中
  if (snap === null) {
    return (
      <section>
        <h2 className="text-base font-semibold mb-2">PC パフォーマンス</h2>
        <div className="text-subtle text-sm">メトリクス未取得 (Concordia 再起動で有効化、 または無効設定)。</div>
      </section>
    );
  }

  const memPct = snap.host.totalMem > 0 ? Math.round((snap.host.usedMem / snap.host.totalMem) * 100) : 0;
  const sessions = [...snap.sessions].sort((a, b) =>
    sortKey === "rss" ? b.rss - a.rss : a.label.localeCompare(b.label),
  );

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">
        PC パフォーマンス
        <span className="text-subtle text-xs ml-2">{fmtTs(Math.floor(snap.sampled_at / 1000))}</span>
      </h2>

      {/* host メモリ / CPU */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        <div className="bg-surface border border-border rounded p-3">
          <div className="text-xs text-subtle">メモリ</div>
          <div className="text-lg font-semibold">{fmtBytes(snap.host.usedMem)} <span className="text-subtle text-sm">/ {fmtBytes(snap.host.totalMem)} ({memPct}%)</span></div>
          <div className="mt-1 h-1.5 bg-muted rounded overflow-hidden">
            <div className={`h-full ${memPct >= 85 ? "bg-danger" : memPct >= 70 ? "bg-warning" : "bg-accent"}`} style={{ width: `${memPct}%` }} />
          </div>
        </div>
        <div className="bg-surface border border-border rounded p-3">
          <div className="text-xs text-subtle">CPU ({snap.host.cpuCount} コア)</div>
          <div className="text-lg font-semibold">{snap.host.loadPct == null ? "—" : `${snap.host.loadPct}%`}</div>
        </div>
      </div>

      {/* セッション別メモリ (並び替え可) */}
      {sessions.length > 0 && (
        <div className="bg-surface border border-border rounded p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold">セッション別メモリ</span>
            <span className="text-subtle text-xs">{sessions.length}</span>
            <div className="ml-auto flex gap-1 text-xs">
              <button onClick={() => setSortKey("rss")} className={`px-2 py-0.5 rounded ${sortKey === "rss" ? "bg-accent text-white" : "bg-muted"}`}>RSS 順</button>
              <button onClick={() => setSortKey("label")} className={`px-2 py-0.5 rounded ${sortKey === "label" ? "bg-accent text-white" : "bg-muted"}`}>名前順</button>
            </div>
          </div>
          <div className="space-y-1">
            {sessions.map((s) => (
              <Link key={s.session_id} to={`/sessions/${encodeURIComponent(s.session_id)}`} className="flex items-center gap-2 text-xs hover:bg-muted rounded px-1 py-0.5">
                <span className="font-mono font-semibold w-20 text-right">{fmtBytes(s.rss)}</span>
                <span className={`px-1 rounded ${statusBadge(s.status as SessionRow["status"])}`}>{s.status}</span>
                <span className="truncate flex-1">{s.label}</span>
                <span className="text-subtle">{s.procCount}p · pid {s.pid}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 上位プロセス + WSL/docker */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        <div className="bg-surface border border-border rounded p-3">
          <div className="text-sm font-semibold mb-1">上位プロセス</div>
          <div className="space-y-0.5">
            {snap.topProcesses.slice(0, 10).map((p) => (
              <div key={p.name} className="flex items-center gap-2 text-xs">
                <span className="font-mono w-20 text-right">{fmtBytes(p.rss)}</span>
                <span className="truncate flex-1">{p.name}</span>
                <span className="text-subtle">×{p.count}</span>
              </div>
            ))}
          </div>
        </div>
        {(snap.wsl.length > 0 || snap.docker.length > 0) && (
          <div className="bg-surface border border-border rounded p-3">
            {snap.wsl.length > 0 && (
              <>
                <div className="text-sm font-semibold mb-1">WSL</div>
                <div className="space-y-0.5 mb-2">
                  {snap.wsl.map((w) => (
                    <div key={w.key} className="flex items-center gap-2 text-xs">
                      <span className="font-mono w-20 text-right">{fmtBytes(w.rss)}</span>
                      <span className="truncate flex-1">{w.key}</span>
                      <span className="text-subtle">{w.side}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {snap.docker.length > 0 && (
              <>
                <div className="text-sm font-semibold mb-1">docker ({snap.docker.length})</div>
                <div className="space-y-0.5">
                  {snap.docker.slice(0, 8).map((d) => (
                    <div key={d.name} className="flex items-center gap-2 text-xs">
                      <span className="font-mono w-20 text-right">{fmtBytes(d.rss)}</span>
                      <span className="truncate flex-1">{d.name}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
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
  const [runtimeOptions, setRuntimeOptions] = useState<Record<string, string>>({});
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
    if (!selected) { setArgs({}); setRuntimeOptions({}); setCwd(""); return; }
    const init: Record<string, string> = {};
    for (const s of selected.input_schema) {
      init[s.name] = s.default !== undefined ? String(s.default) : "";
    }
    const optionInit: Record<string, string> = {};
    const defaultOptions = selected.default_options ?? {};
    for (const opt of selected.runtime_options ?? []) {
      optionInit[opt.key] = optionValue(defaultOptions[opt.key]);
    }
    setArgs(init);
    setRuntimeOptions(optionInit);
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
      const options: Record<string, unknown> = {};
      for (const opt of selected.runtime_options ?? []) {
        const v = runtimeOptions[opt.key];
        if (v === undefined || v === "") continue;
        if (opt.type === "number") options[opt.key] = Number(v);
        else if (opt.type === "boolean") options[opt.key] = v === "true";
        else options[opt.key] = v;
      }
      if (Object.keys(options).length > 0) body.options = options;
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
          {selected && (selected.runtime_options ?? []).length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {(selected.runtime_options ?? []).map((opt) => (
                <label key={opt.key} className="text-xs space-y-1">
                  <span className="text-subtle">
                    {opt.label} <span className="font-mono">{opt.key}</span>
                  </span>
                  {opt.type === "select" ? (
                    <select
                      className="foundation-form w-full text-sm"
                      value={runtimeOptions[opt.key] ?? ""}
                      onChange={(e) => setRuntimeOptions({ ...runtimeOptions, [opt.key]: e.target.value })}
                      disabled={sending}
                    >
                      <option value="">provider default</option>
                      {(opt.choices ?? []).map((choice) => (
                        <option key={choice.value} value={choice.value}>{choice.label}</option>
                      ))}
                    </select>
                  ) : opt.type === "boolean" ? (
                    <select
                      className="foundation-form w-full text-sm"
                      value={runtimeOptions[opt.key] ?? ""}
                      onChange={(e) => setRuntimeOptions({ ...runtimeOptions, [opt.key]: e.target.value })}
                      disabled={sending}
                    >
                      <option value="">provider default</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="foundation-form w-full text-sm"
                      value={runtimeOptions[opt.key] ?? ""}
                      onChange={(e) => setRuntimeOptions({ ...runtimeOptions, [opt.key]: e.target.value })}
                      disabled={sending}
                    />
                  )}
                </label>
              ))}
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
