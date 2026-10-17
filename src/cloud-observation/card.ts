import { redactSecrets } from "../shared/redact-secrets.js";
import { observationLiveness, type ObservationState } from "./state.js";

const labels: Record<ObservationState["phase"], string> = {
  awaiting: "観測待ち", working: "作業中", waiting_answer: "回答待ち",
  answer_ready: "回答保存済み（クラウドの再開未確認）",
  reported_finished: "完了の自己申告（成果未検証）", reported_failed: "失敗の自己申告",
};

/** Presentation only: no remote URLs, credentials or remote timestamps. */
export function observationCard(state: ObservationState, now: number): {
  content: string; allowedMentions: { parse: [] };
} {
  const safe = (text: string): string => redactSecrets(text)
    .replace(/https?:\/\/[^\s<>]+/gi, "[URL省略]")
    .replace(/@/g, "＠").replace(/</g, "＜").replace(/>/g, "＞").slice(0, 1000);
  const alive = observationLiveness(state, now);
  const lines = [`状態: ${labels[state.phase]}`, `通信: ${alive === "recent" ? "直近の通知あり" : alive === "disconnected" ? "通信途絶（成否不明）" : "未観測"}`];
  if (state.lastEvent?.message || state.summary) lines.push(safe(state.lastEvent?.message || state.summary));
  if (state.question && !state.question.answer) {
    lines.push(`確認事項 ${state.question.id}: ${safe(state.question.text)}`);
    lines.push(`回答方法: /回答 ${state.question.id} 回答内容`);
    lines.push("この質問への回答待ちです。通知の途絶や時間経過では再開しません。");
  }
  return { content: lines.join("\n").slice(0, 1950), allowedMentions: { parse: [] } };
}
