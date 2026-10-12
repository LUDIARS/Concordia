/**
 * 拠点: セッションの質問 (question.posted) を本社へ送る質問カードの形にする (SPEC-FED-SITE-FORUM-PARITY)。
 *
 * 旧形式 (string[]) と新形式 ({label, description?}[]) の両方を受け、 protocol の上限に収める。
 * 計画承認 (plan_approval) は専用の承認 UI を持つので連合では送らない。
 */
import type { FederationEgressQuestion } from "./protocol.js";

export function toEgressQuestion(event: {
  kind?: "question" | "plan_approval";
  question_id: number;
  question: string;
  options: Array<string | { label: string; description?: string }>;
  multi_select?: boolean;
}): FederationEgressQuestion | null {
  if (event.kind === "plan_approval") return null;
  const prompt = Array.from(event.question.trim()).slice(0, 2_000).join("");
  if (!prompt || !Number.isInteger(event.question_id) || event.question_id <= 0) return null;
  const options = event.options
    .map((option) => typeof option === "string" ? { label: option } : option)
    .map((option) => ({
      label: Array.from(option.label?.trim() ?? "").slice(0, 100).join(""),
      description: option.description?.trim() ? Array.from(option.description.trim()).slice(0, 100).join("") : undefined,
    }))
    .filter((option) => option.label.length > 0)
    .slice(0, 25)
    .map((option) => option.description ? option : { label: option.label });
  return {
    question_id: event.question_id,
    prompt,
    options,
    ...(event.multi_select ? { multi_select: true } : {}),
  };
}

/** 本社のカードで選ばれた index を拠点の回答形にする。 2 つ以上なら複数選択として渡す。 */
export function toAnswerBody(questionId: number, optionIndexes: readonly number[]):
  { question_id: number; answer_index: number } | { question_id: number; answer_indices: number[] } {
  return optionIndexes.length === 1
    ? { question_id: questionId, answer_index: optionIndexes[0]! }
    : { question_id: questionId, answer_indices: [...optionIndexes] };
}

/** 本社で書かれた返信を拠点の面に出すときの webhook 名 (誰が本社から書いたか分かるように)。 */
export function hqEchoUsername(authorLabel: string): string {
  return Array.from(`${authorLabel.trim() || "本社の利用者"} (本社)`).slice(0, 80).join("");
}
