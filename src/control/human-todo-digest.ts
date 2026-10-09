/**
 * 人間のやること (human to-do) の集約と、自動確認での報告要否の判定 (純関数)。
 *
 * 2026-10-08 neco 指示「人間のやることまとめる実装を入れる。自動確認時に人間のやることが
 * 残ってればメンションつけて報告。ピン留めもする。前回の自動確認から人間のやることに
 * 動きがなければ通知はしない (自動確認は止めない)」。
 *
 * - 正本は既存の状態所有者のまま: human-wait (session metadata) と未回答の質問カード
 *   (`discord_pending_questions`)。ここは束ねて要約値を作るだけで、回答・解決を表現しない。
 * - 報告済みの要約値は session metadata `cc_human_todo_report` に置き、Cc 再起動をまたいで
 *   「前回から変化が無い」を判定する。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2 人間のやることの報告
 */
import { createHash } from "node:crypto";
import type { HumanWaitState } from "./human-wait.js";

export const HUMAN_TODO_REPORT_KEY = "cc_human_todo_report";

/** 1 項目の本文上限。Discord 1 通に収め、長い質問文で他の項目を押し出さない。 */
const ITEM_TEXT_LIMIT = 300;
/** 報告に並べる最大件数。超えた分は件数だけ示す。 */
export const HUMAN_TODO_LIST_LIMIT = 10;

export type HumanTodoKind = "human_wait" | "question";

export interface HumanTodoItem {
  kind: HumanTodoKind;
  text: string;
  /** human-wait の Actio task 参照。質問カードは空。 */
  references: string[];
}

export interface HumanTodoQuestion {
  id: number;
  question: string;
}

export interface HumanTodoReportRecord {
  digest: string;
  count: number;
  reported_at: number;
}

/** human-wait と未回答質問を、報告順 (人間待ち → 古い質問から) に並べる。 */
export function collectHumanTodos(input: {
  humanWait: HumanWaitState | null;
  questions: readonly HumanTodoQuestion[];
}): HumanTodoItem[] {
  const items: HumanTodoItem[] = [];
  if (input.humanWait?.active && input.humanWait.summary.trim()) {
    items.push({
      kind: "human_wait",
      text: clip(input.humanWait.summary),
      references: [...new Set(input.humanWait.task_references)].sort(),
    });
  }
  for (const question of [...input.questions].sort((a, b) => a.id - b.id)) {
    const text = clip(question.question);
    if (text) items.push({ kind: "question", text, references: [] });
  }
  return items;
}

/** 項目の並びと内容だけで決まる要約値。時刻を含めないので、変化が無ければ同じ値になる。 */
export function humanTodoDigest(items: readonly HumanTodoItem[]): string {
  const canonical = JSON.stringify(items.map((item) => [item.kind, item.text, item.references]));
  return createHash("sha256").update(canonical).digest("hex");
}

export type HumanTodoReportDecision =
  | { kind: "report"; digest: string }
  | { kind: "resolved" }
  | { kind: "unchanged" }
  | { kind: "none" };

/**
 * - 項目あり・前回と違う (初回含む) → report (メンション付き報告 + ピン留め)
 * - 項目あり・前回と同じ → unchanged (人間向け通知を省く)
 * - 項目なし・前回報告あり → resolved (解消の記録とピンの解除)
 * - 項目なし・前回報告なし → none
 */
export function decideHumanTodoReport(input: {
  items: readonly HumanTodoItem[];
  last: HumanTodoReportRecord | null;
}): HumanTodoReportDecision {
  if (!input.items.length) return input.last ? { kind: "resolved" } : { kind: "none" };
  const digest = humanTodoDigest(input.items);
  return input.last?.digest === digest ? { kind: "unchanged" } : { kind: "report", digest };
}

export function readHumanTodoReport(metadata: string | null): HumanTodoReportRecord | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[HUMAN_TODO_REPORT_KEY];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.digest !== "string" || !row.digest
      || typeof row.count !== "number" || typeof row.reported_at !== "number") return null;
    return { digest: row.digest, count: row.count, reported_at: row.reported_at };
  } catch {
    return null;
  }
}

const KIND_LABELS: Record<HumanTodoKind, string> = {
  human_wait: "判断待ち",
  question: "未回答の質問",
};

/**
 * 報告本文。項目は人や AI が書いた文なので、呼び出し側は allowedMentions を
 * 構造化フィールドで絞って送る (本文中の @ 表記を発火させない)。
 */
export function renderHumanTodoReport(items: readonly HumanTodoItem[]): string {
  const shown = items.slice(0, HUMAN_TODO_LIST_LIMIT);
  const lines = [
    `🙋 **人間のやること** (${items.length} 件) — 自動確認で内容の変化を検知しました。`,
    ...shown.map((item, index) => {
      const refs = item.references.length ? ` (${item.references.join(", ")})` : "";
      return `${index + 1}. [${KIND_LABELS[item.kind]}] ${item.text}${refs}`;
    }),
  ];
  if (items.length > shown.length) lines.push(`ほか ${items.length - shown.length} 件`);
  lines.push("前回から変化が無い間は通知しません。自動確認は続けます。");
  return lines.join("\n");
}

export function renderHumanTodoResolved(): string {
  return "✅ **人間のやること** は残っていません (自動確認で解消を確認しました)。";
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ITEM_TEXT_LIMIT ? `${flat.slice(0, ITEM_TEXT_LIMIT - 1)}…` : flat;
}
