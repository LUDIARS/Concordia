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
    <ul className="max-h-64 overflow-y-auto divide-y divide-border text-xs leading-5">
      {open.map(task => <li key={task.path}>
        <details className="group">
          <summary title={task.title} className="cursor-pointer truncate group-open:whitespace-normal group-open:break-words">{task.title}</summary>
        </details>
      </li>)}
    </ul>
  </section>;
}
