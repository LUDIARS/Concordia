// Slack 投稿ペイロードの組み立て + interaction 解析（純粋関数）。
// 副作用 (Web API 呼び出し) は bot.ts 側。ここはテスト可能なロジックだけ。

import { shouldDropForRelay } from "../discord/egress-filters.js";

/** Slack section text の実用上限に合わせた truncate（block text は 3000 字制限）。 */
const MAX_TEXT = 2900;

export function truncateForSlack(text: string, max = MAX_TEXT): string {
  const t = text ?? "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * transcript.frame を Slack に中継すべきか判定し、本文を抽出する。
 * discord/egress.ts と同じ意味論:
 *   - kind=text && role=assistant : AI の人間向け本文
 *   - kind=summary                : 会話要約
 *   - それ以外 (tool-use/result/thinking/raw/user) は null（中継しない）
 * 本文ベースの drop フィルタ (guardian JSON 等) も適用する。
 */
export function extractRelayableFrame(
  kind: string,
  payload: unknown,
): { role: "assistant" | "summary"; text: string } | null {
  let role: "assistant" | "summary";
  let text: string;
  if (kind === "text") {
    const p = payload as { role?: string; text?: string } | null | undefined;
    if (!p || typeof p.text !== "string" || !p.text) return null;
    if (p.role !== "assistant") return null;
    role = "assistant";
    text = p.text;
  } else if (kind === "summary") {
    const p = payload as { text?: string; summary?: string } | null | undefined;
    const candidate = typeof p?.text === "string" ? p.text : typeof p?.summary === "string" ? p.summary : null;
    if (!candidate) return null;
    role = "summary";
    text = candidate;
  } else {
    return null;
  }
  if (shouldDropForRelay(text)) return null;
  return { role, text };
}

const ANSWER_ACTION_PREFIX = "cc_answer";

/** AskUserQuestion の選択肢ボタン block を組む。action_id に question_id と index を埋める。 */
export function buildQuestionBlocks(
  questionId: number,
  question: string,
  options: Array<string | { label: string; description?: string }>,
): { text: string; blocks: unknown[] } {
  const norm = options.map((o) => (typeof o === "string" ? { label: o } : o));
  const elements = norm.slice(0, 25).map((o, i) => ({
    type: "button",
    text: { type: "plain_text", text: truncateForSlack(o.label, 75), emoji: true },
    value: String(i),
    action_id: `${ANSWER_ACTION_PREFIX}:${questionId}:${i}`,
  }));
  const optionLines = norm
    .map((o, i) => `*${i + 1}.* ${o.label}${o.description ? ` — ${o.description}` : ""}`)
    .join("\n");
  return {
    text: `❓ ${question}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `❓ *${truncateForSlack(question)}*` } },
      { type: "section", text: { type: "mrkdwn", text: truncateForSlack(optionLines) } },
      { type: "actions", elements },
    ],
  };
}

/**
 * ボタン action_id (`cc_answer:<questionId>:<index>`) を解析する。
 * 形式不一致なら null（他の interaction を無視するため）。
 */
export function parseAnswerActionId(actionId: string): { questionId: number; answerIndex: number } | null {
  const parts = (actionId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ANSWER_ACTION_PREFIX) return null;
  const questionId = Number(parts[1]);
  const answerIndex = Number(parts[2]);
  if (!Number.isInteger(questionId) || !Number.isInteger(answerIndex) || answerIndex < 0) return null;
  return { questionId, answerIndex };
}
