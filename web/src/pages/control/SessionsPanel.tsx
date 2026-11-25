import { useState } from "react";
import { controlApi } from "./controlApi.js";
import { ProjectMicro } from "./ProjectMicro.js";
import { projectGraph } from "./projectGraph.js";
import { usePolling } from "./usePolling.js";
import { ReconnectingStatus } from "../../components/ReconnectingStatus.js";

export function SessionsPanel() {
  const { data, error, reconnecting } = usePolling((signal) => controlApi.sessions(signal), 15_000);
  const [view, setView] = useState<"macro" | "micro">("macro");
  const [selected, setSelected] = useState("");
  const projects = projectGraph(data?.items ?? []);
  const current = selected ? projects.find(project => project.name === selected) : projects[0];
  const openProject = (name: string) => { setSelected(name); setView("micro"); };
  return <section aria-label="動いているセッション" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">稼働プロジェクト {data && `(${projects.length})`}</h2>
      <div className="flex gap-1 rounded border border-border p-1" aria-label="表示切替">
        {(["macro", "micro"] as const).map(mode => <button type="button" key={mode} aria-pressed={view === mode}
          onClick={() => setView(mode)} className={`rounded px-3 py-1 text-sm ${view === mode ? "bg-accent text-white" : "text-subtle"}`}>{mode === "macro" ? "マクロ" : "ミクロ"}</button>)}
      </div>
    </div>
    {reconnecting ? <ReconnectingStatus /> : error && <p role="alert" className="text-amber-400">セッションを取得できません: {error === "control_disabled" ? "管制が OFF です" : error}</p>}
    {!data && !error && <p role="status">読み込み中…</p>}
    {data && !projects.length && <p className="text-subtle">動いているセッションはありません。</p>}
    {view === "macro" && projects.length > 0 && <div aria-label="プロジェクトグラフ" className="rounded border border-border bg-surface/40 p-4">
      <div className="inline-block rounded border border-accent px-3 py-1 text-sm">稼働中 · {data?.items.length} セッション</div>
      <ul className="ml-4 border-l border-border py-2">{projects.map(p => <li key={p.name} className="flex items-center py-1">
        <span aria-hidden="true" className="w-5 shrink-0 border-t border-border" />
        <button type="button" onClick={() => openProject(p.name)} className="w-full min-w-0 rounded border border-border bg-surface px-3 py-2 text-left hover:border-accent">
          <span className="flex flex-wrap items-baseline justify-between gap-2"><strong>{p.name}</strong><span className="text-xs">{p.sessions.length} セッション</span></span>
          <span className="block break-words text-sm">{[...new Set(p.sessions.map(row => row.current_task || "作業内容未報告"))].join(" ／ ")}</span>
          <span className="flex flex-wrap items-center gap-x-3 text-xs text-subtle">{[...p.counts].map(([status, count]) => <span key={status}>{status} {count}</span>)}
            <span>計画進捗 {p.percent === null ? "未計測" : `${p.percent}%（${p.done}/${p.total} ステップ）`}</span>
            {p.measured > 0 && p.measured < p.sessions.length && <span>計測 {p.measured}/{p.sessions.length} セッション</span>}
          </span>
          {p.percent !== null && <progress aria-label={p.name + " の計画進捗"} className="h-1 w-full accent-current" value={p.done} max={p.total} />}
        </button></li>)}</ul>
    </div>}
    {view === "micro" && projects.length > 0 && <>
      <label className="text-sm">プロジェクト <select className="rounded border border-border bg-surface p-1"
        value={current?.name ?? ""} onChange={e => setSelected(e.target.value)}>
        {!current && <option value="">選択してください</option>}
        {projects.map(p => <option key={p.name}>{p.name}</option>)}</select></label>
      {current ? <ProjectMicro key={current.name} sessions={current.sessions} /> : <p>選択していたプロジェクトには稼働セッションがありません。</p>}
    </>}
  </section>;
}
