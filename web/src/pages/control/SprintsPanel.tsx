/** スプリント状況欄 (Cc v5 実装メモ 12)。正本は Actio、Cc の投影を読み取り専用で出す (Cc から Actio へ書かない)。 */
import { controlApi } from "./controlApi.js";
import { usePolling } from "./usePolling.js";
import { ReconnectingStatus } from "../../components/ReconnectingStatus.js";

export function SprintsPanel() {
  const { data, error, reconnecting } = usePolling((signal) => controlApi.sprints(signal), 60_000);
  const sprints = data?.sprints.filter((sprint) => !sprint.closed) ?? [];
  return <section className="space-y-2" aria-label="スプリント状況">
    <h2 className="text-lg font-semibold">スプリント状況 {data ? `(${sprints.length})` : ""}</h2>
    {reconnecting ? <ReconnectingStatus /> : error && <p role="alert" className="text-amber-400">スプリントを取得できません: {error}</p>}
    {data && sprints.length === 0 && <p className="text-subtle">進行中のスプリントはありません。</p>}
    {sprints.map((sprint) => <article key={sprint.dialogue_key} className="border border-border rounded p-3 text-sm space-y-1">
      <div className="flex flex-wrap gap-2"><strong>{sprint.sprint_name}</strong><span>{sprint.phase}</span>
        {sprint.held && <span className="text-amber-400">保留中</span>}<span className="text-subtle">タスク {sprint.task_count}</span></div>
      {sprint.summary && <p className="whitespace-pre-wrap break-words text-subtle">{sprint.summary}</p>}
    </article>)}
  </section>;
}
