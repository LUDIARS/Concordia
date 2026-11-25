/** Actio タスク欄 (Cc v5)。既存の taskflow 一覧 API を読むだけ。 */
import { api } from "../../api.js";
import { failureGuidance } from "../../lib/taskflow-failure.js";
import { usePolling } from "./usePolling.js";
import { ReconnectingStatus } from "../../components/ReconnectingStatus.js";

export function TasksPanel() {
  const { data, error, reconnecting, reload } = usePolling((signal) => api.taskflowOverview({ signal }), 30_000);
  const partial = data?.partial_reason;
  const open = data?.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled") ?? [];
  return <section className="space-y-2" aria-label="Actio タスク">
    <h2 className="text-lg font-semibold">Actio タスク {data ? `(${open.length}${partial ? " 件取得" : ""})` : ""}</h2>
    {reconnecting && <ReconnectingStatus />}
    {error && (!reconnecting || data) && <p role={reconnecting ? undefined : "alert"} className={reconnecting ? "text-xs text-subtle" : "text-amber-400"}>
      Actio タスクを更新できませんでした。{error}{data && " 前回取得した情報を表示しています。"}
    </p>}
    {!error && partial && <p role="alert" className="text-amber-400">
      Actio タスクを一部だけ取得しました。{failureGuidance(partial)}
    </p>}
    {(error || partial) && <button type="button" className="text-xs text-accent" onClick={reload}>タスク一覧を更新</button>}
    {data && !partial && !error && open.length === 0 && <p className="text-subtle">進行中のタスクはありません。</p>}
    <ul className="max-h-64 overflow-y-auto divide-y divide-border text-xs leading-5">
      {open.map(task => <li key={task.path}>
        <details className="group">
          <summary title={task.title} className="cursor-pointer truncate group-open:whitespace-normal group-open:break-words">{task.title}</summary>
        </details>
      </li>)}
    </ul>
  </section>;
}
