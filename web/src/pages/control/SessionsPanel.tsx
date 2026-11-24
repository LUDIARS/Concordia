/** 動いているセッション欄 (Cc v5)。プロジェクト・branch・現在のタスク・分類・最終活動と、プランと進捗 (実装メモ 13)。 */
import { controlApi } from "./controlApi.js";
import { SessionProgress } from "./SessionProgress.js";
import { usePolling } from "./usePolling.js";

const STATUS_LABEL: Record<string, string> = {
  working: "作業中", awaiting_result: "結果待ち", human_wait: "人間待ち", stalled: "停止", unresponsive: "応答なし", end_candidate: "終了候補",
};

export function SessionsPanel() {
  const { data, error } = usePolling((signal) => controlApi.sessions(signal), 15_000);
  return <section className="space-y-2" aria-label="動いているセッション">
    <h2 className="text-lg font-semibold">動いているセッション {data ? `(${data.items.length})` : ""}</h2>
    {error && <p role="alert" className="text-amber-400">セッションを取得できません: {error === "control_disabled" ? "管制が OFF です (設定「管制セッションを動かす」)" : error}</p>}
    {data && data.items.length === 0 && <p className="text-subtle">動いているセッションはありません。</p>}
    {data?.items.map((row) => <article key={row.session_id} className="border border-border rounded p-3 space-y-2">
      <div className="flex flex-wrap gap-2 text-sm">
        <strong>{row.project}</strong>
        {row.branch && <span className="text-subtle">{row.branch}</span>}
        <span>{row.status ? STATUS_LABEL[row.status] ?? row.status : "未分類"}</span>
        {row.last_activity_at && <span className="text-subtle">最終活動 {new Date(row.last_activity_at * 1000).toLocaleString()}</span>}
        <a href={`/sessions/${row.session_id}`} className="text-accent underline">Web チャット</a>
        {row.link && <a href={row.link} className="text-accent underline">Discord</a>}
      </div>
      {row.current_task && <p className="text-sm break-words">{row.current_task}</p>}
      <SessionProgress row={row} />
    </article>)}
  </section>;
}
