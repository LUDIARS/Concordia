/** Actio タスク欄 (Cc v5)。既存の taskflow 一覧 API を読むだけ。 */
import { useEffect } from "react";
import { api } from "../../api.js";
import { ReconnectingStatus } from "../../components/ReconnectingStatus.js";
import { failureGuidance } from "../../lib/taskflow-failure.js";
import { usePolling } from "./usePolling.js";

export function TasksPanel() {
  const { data, error, reconnecting, reload } = usePolling((signal) => api.taskflowOverview({ signal }), 30_000);
  const partial = data?.partial_reason;
  const refreshError = data?.refresh_error;
  const fetchedAt = data?.fetched_at;
  const unconfirmed = fetchedAt === null || !!partial || !!refreshError || data?.stale;
  const ageSeconds = fetchedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(fetchedAt)) / 1000)) : 0;
  const age = ageSeconds < 60 ? `${ageSeconds} 秒前` : `${Math.floor(ageSeconds / 60)} 分前`;
  const open = data?.tasks.filter((task) => task.status !== "done" && task.status !== "cancelled") ?? [];
  useEffect(() => {
    if (!data?.refreshing || error) return;
    const timer = setTimeout(reload, 2_000);
    return () => clearTimeout(timer);
  }, [data, error, reload]);
  return <section className="space-y-2" aria-label="Actio タスク">
    <h2 className="text-lg font-semibold">Actio タスク {data && (!unconfirmed || open.length > 0)
      ? `(${open.length}${unconfirmed ? " 件表示" : ""})` : ""}</h2>
    {reconnecting && <ReconnectingStatus />}
    {fetchedAt && <p className="text-xs text-subtle">
      取得時刻 <time dateTime={fetchedAt}>{new Date(fetchedAt).toLocaleString("ja-JP")}</time>
      {`（${age}${data?.stale ? "・前回の一覧" : ""}）`}
    </p>}
    {data?.refreshing && !reconnecting && <p className="text-xs text-subtle" role="status">
      {fetchedAt ? "一覧を更新中…" : "一覧を取得中…"}
    </p>}
    {error && (!reconnecting || data) && <p role={reconnecting ? undefined : "alert"} className={reconnecting ? "text-xs text-subtle" : "text-amber-400"}>
      Actio タスクを更新できませんでした。{error}{data && " 前回取得した情報を表示しています。"}
    </p>}
    {!error && partial && <p role="alert" className="text-amber-400">
      Actio タスクを一部だけ取得しました。{failureGuidance(partial)}
    </p>}
    {!error && refreshError && refreshError !== partial && <p role="alert" className="text-amber-400">
      Actio タスクを更新できませんでした。{failureGuidance(refreshError)}
      {fetchedAt ? " 前回取得した一覧を表示しています。" : " 現在の件数は未確認です。"}
    </p>}
    {(error || partial || refreshError) && <button type="button" className="text-xs text-accent" onClick={reload}>タスク一覧を更新</button>}
    {data && !unconfirmed && !error && open.length === 0 && <p className="text-subtle">進行中のタスクはありません。</p>}
    <ul className="max-h-64 overflow-y-auto divide-y divide-border text-xs leading-5">
      {open.map(task => <li key={task.path}>
        <details className="group">
          <summary title={task.title} className="cursor-pointer truncate group-open:whitespace-normal group-open:break-words">{task.title}</summary>
        </details>
      </li>)}
    </ul>
  </section>;
}
