/** Actio タスク欄 (Cc v5)。既存の taskflow 一覧 API を読むだけ。 */
import { api } from "../../api.js";
import { usePolling } from "./usePolling.js";

export function TasksPanel() {
  const { data, error } = usePolling(() => api.taskflowOverview(), 30_000);
  const open = data?.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled") ?? [];
  return <section className="space-y-2" aria-label="Actio タスク">
    <h2 className="text-lg font-semibold">Actio タスク {data ? `(${open.length})` : ""}</h2>
    {error && <p role="alert" className="text-amber-400">Actio タスクを取得できません: {error}</p>}
    {data && open.length === 0 && <p className="text-subtle">進行中のタスクはありません。</p>}
    <ul className="space-y-1 text-sm">
      {open.slice(0, 100).map((task) => <li key={task.path} className="flex flex-wrap gap-2">
        <span className="font-semibold">{task.project}</span>
        <span className="break-words">{task.title}</span>
        <span className="text-subtle">{task.status}</span>
        {task.source_session && <a href={`/sessions/${task.source_session}`} className="text-accent underline">担当セッション</a>}
        {task.pr && (task.pr.url ? <a href={task.pr.url} className="text-accent underline">PR #{task.pr.number}</a> : <span>PR #{task.pr.number}</span>)}
      </li>)}
    </ul>
  </section>;
}
