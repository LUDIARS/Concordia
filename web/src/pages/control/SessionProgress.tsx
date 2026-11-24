/**
 * セッションのプランと進捗 (Cc v5 実装メモ 13)。/control の「動いているセッション」と /desk の依頼詳細で使う。
 * 未計測は「未計測」、読めなかった欄は「取得できません」と出す (0% や空に見せない)。
 */
import type { SessionProgressRow } from "./controlApi.js";

const STEP_MARK: Record<string, string> = { completed: "✅", in_progress: "▶", pending: "・" };

export function SessionProgress({ row }: { row: SessionProgressRow }) {
  const { plan, progress } = row;
  return <div className="space-y-2 text-sm">
    <div>
      <span className="font-semibold">プラン</span>
      <span className="ml-2 text-subtle">作業段階: {plan.work_phase.label}</span>
      {plan.desktop_plan_status && <span className="ml-2 text-subtle">({plan.desktop_plan_status})</span>}
      {plan.work_phase.design_summary && <p className="text-subtle whitespace-pre-wrap break-words">{plan.work_phase.design_summary}</p>}
      {plan.steps.length === 0
        ? <p className="text-subtle">ステップはまだありません。</p>
        : <ol className="mt-1 space-y-0.5">{plan.steps.map((step, index) => <li key={index} data-status={step.status}>
            {STEP_MARK[step.status] ?? "・"} {step.text}
          </li>)}</ol>}
    </div>
    <div>
      <span className="font-semibold">進捗</span>
      <span className="ml-2">ステップ {progress.steps_completed} / {progress.steps_total}</span>
      <span className="ml-2">自動確認の進捗率: {progress.followup_rate === null ? "未計測" : `${progress.followup_rate}%`}</span>
      <div>
        Actio タスク:{" "}
        {progress.tasks.state === "unavailable"
          ? <span className="text-amber-400">取得できません</span>
          : progress.tasks.items.length === 0
            ? <span className="text-subtle">紐付けなし</span>
            : progress.tasks.items.map((task) => <span key={task.reference} className="mr-2">{task.reference} ({task.state === "unknown" ? "不明" : task.status})</span>)}
      </div>
    </div>
  </div>;
}
