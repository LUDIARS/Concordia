import type { TaskflowExecution, TaskflowExecutionState } from "../../api.js";

// タスクの業務状態 (status) とは別に、 委託の実行状況を 1 セルで見せる (CC-TF-EXEC-01)。
const STATE_LABEL: Record<TaskflowExecutionState, string> = {
  not_started: "未起動",
  queued: "起動待ち",
  launching: "起動中",
  received: "受領",
  working: "作業中",
  waiting: "待機",
  stopped: "停止",
  finished: "完了報告",
};

const STATE_BADGE: Record<TaskflowExecutionState, string> = {
  not_started: "bg-subtle/20 text-subtle",
  queued: "bg-warn/20 text-warn",
  launching: "bg-warn/20 text-warn",
  received: "bg-accent/20 text-accent",
  working: "bg-accent/20 text-accent",
  waiting: "bg-warn/20 text-warn",
  stopped: "bg-danger/20 text-danger",
  finished: "bg-ok/20 text-ok",
};

export function ExecutionCell({ execution }: { execution: TaskflowExecution | undefined }) {
  if (!execution) return <span className="text-subtle">—</span>;
  return (
    <div className="space-y-1 text-xs max-w-sm">
      <div className="flex flex-wrap items-center gap-1">
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${STATE_BADGE[execution.state]}`}>
          {STATE_LABEL[execution.state]}
        </span>
        {execution.received_at !== null && (
          <span className="text-subtle" title="子セッションが起動した時刻">受領 {formatTime(execution.received_at)}</span>
        )}
      </div>
      {execution.current_action && (
        <div className="truncate" title={execution.current_action.label}>
          <span className="text-subtle">{execution.current_action.source === "tool" ? "動作" : "作業"}: </span>
          <span className="font-mono">{execution.current_action.label}</span>
          {execution.current_action.at !== null && (
            <span className="text-subtle"> · {formatTime(execution.current_action.at)}</span>
          )}
        </div>
      )}
      {execution.last_response && (
        <div className="line-clamp-2 text-subtle" title={execution.last_response.text}>
          最終応答 ({formatTime(execution.last_response.at)}): {execution.last_response.text}
        </div>
      )}
      {execution.stop_reason && (
        <div className="text-danger line-clamp-2" title={execution.stop_reason}>停止理由: {execution.stop_reason}</div>
      )}
      {execution.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {execution.artifacts.map((artifact) => artifact.url ? (
            <a key={`${artifact.kind}:${artifact.label}`} className="text-accent" href={artifact.url} target="_blank" rel="noreferrer">
              {artifact.label}
            </a>
          ) : (
            <span key={`${artifact.kind}:${artifact.label}`} className="font-mono text-subtle" title={artifact.kind}>
              {artifact.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("ja-JP", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
