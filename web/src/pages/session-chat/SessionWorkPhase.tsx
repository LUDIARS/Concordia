/** @implements CC-SESSION-WORK-PHASES — display recorded stage without implying execution authority. */
// @spec セッションの設計・開始確認・実装・調整
import type { SessionWorkPhase as Phase } from "../../api.js";

const labels: Record<Phase["phase"], string> = {
  design: "設計", confirmation: "確認", implementation: "実装", adjustment: "調整", unknown: "未確認",
};

export function SessionWorkPhaseBadge({ value }: { value?: Phase }) {
  const phase = value?.phase ?? "unknown";
  return <span className={phase === "confirmation" ? "text-accent" : "text-subtle"} title={value?.reason}>
    作業: {labels[phase]}{phase === "confirmation" ? "（開始確認待ち）" : ""}
  </span>;
}

export function SessionWorkPhaseDetails({ value }: { value?: Phase }) {
  return <section aria-label="作業段階" className="mt-4 space-y-2 rounded border border-border p-3 text-sm">
    <h3 className="font-semibold"><SessionWorkPhaseBadge value={value} /></h3>
    <p className="whitespace-pre-wrap break-words">{value?.design_summary || "設計概要はまだ記録されていません。"}</p>
    {value?.reason && <p className="break-words text-subtle">{value.reason}</p>}
    {value?.phase === "confirmation" && <p>提示された設計で実装を始めてよいか、会話で回答してください。</p>}
    {value?.approval_reference && <p className="break-words text-subtle">開始指示の参照: {value.approval_reference}</p>}
  </section>;
}
