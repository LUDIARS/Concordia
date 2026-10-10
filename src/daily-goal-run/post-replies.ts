/**
 * デイリーゴールチャンネルへ返す文面 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 書いてほしいこと / 2. 聞き返し / 7. 9:00 の通知
 *
 * 聞き返しは「何が読み取れて、 何が足りないか」を 1 通で返す。 登録時は読み取り結果を返す。
 */

import { describePermissions } from "./prompts.js";
import { PERMISSION_LABELS, POST_FIELD_LABELS, type DailyGoal, type ExtractedGoal, type PermissionKey, type PostField } from "./domain.js";

/** 投稿の書き方 (チャンネルの説明・9:00 の通知・読み取り失敗の返信に載せる)。 */
export const POSTING_GUIDE: readonly string[] = [
  "その日の目標を 1 投稿 1 ゴールで書いてください。書いてほしいこと:",
  "- プロジェクト (略称でもフルネームでもよい)",
  "- ゴール (その日に達成すること)",
  "- 受入条件 (確認で照合できる形。例: 「PR がマージされ、Cc で反映を確認」)",
  "- 任意: 許可 (マージ / テスト / サービス操作 / 反映 のうち許すもの)、Actio task ID",
  "書式で書くと確実に読み取れます:",
  "```",
  "プロジェクト: Cc",
  "ゴール: …",
  "受入条件:",
  "- …",
  "許可: テスト",
  "task: <Actio task ID>",
  "```",
  "今日は目標を置かない場合は「目標なし」とだけ投稿してください (目標なしの日も問題ありません)。",
];

export const CHANNEL_TOPIC = "その日の目標を投稿するとデイリーゴールとして登録します (1 投稿 1 ゴール: プロジェクト / ゴール / 受入条件 / 任意で許可・Actio task)。目標が無い日は「目標なし」と投稿。締切は翌朝 4:00。";

function readingLines(extracted: ExtractedGoal | null, project: string | null): string[] {
  if (!extracted) return [];
  const lines: string[] = [];
  if (project) lines.push(`- プロジェクト: ${project}`);
  else if (extracted.project) lines.push(`- プロジェクト: 「${extracted.project}」 (登録済みのプロジェクトとして一意に決まりません)`);
  if (extracted.goalText) lines.push(`- ゴール: 「${extracted.goalText}」`);
  if (extracted.acceptance.length) lines.push("- 受入条件:", ...extracted.acceptance.map((item, i) => `  ${i + 1}. ${item}`));
  return lines;
}

export function draftReply(input: {
  extracted: ExtractedGoal | null; project: string | null; missing: readonly PostField[]; failure?: string;
}): string {
  if (input.failure) {
    return [`投稿の読み取りに失敗しました (${input.failure})。推測では登録しません。`,
      "このスレッドで書式どおりに書き直すか、元の投稿を編集してください。", "", ...POSTING_GUIDE].join("\n");
  }
  const read = readingLines(input.extracted, input.project);
  return [
    "まだ登録していません。",
    ...(read.length ? ["読み取れたこと:", ...read] : ["読み取れた項目はありません。"]),
    "足りないこと:",
    ...input.missing.map((field) => `- ${POST_FIELD_LABELS[field]}`),
    input.missing.includes("acceptance") ? "何がそろったら達成としますか? このスレッドで返信するか、元の投稿を編集してください。"
      : "このスレッドで返信するか、元の投稿を編集してください。",
  ].join("\n");
}

export function registeredReply(goal: DailyGoal, input: { droppedPermissions: readonly PermissionKey[]; deadline: string; nearDeadline: boolean }): string {
  return [
    `デイリーゴールとして登録しました (${goal.id})。専用セッションをすぐ起動します。`,
    `- プロジェクト: ${goal.project}`,
    `- ゴール: ${goal.goalText}`,
    "- 受入条件:", ...goal.acceptance.map((item, i) => `  ${i + 1}. ${item}`),
    `- 許可: ${describePermissions(goal.permissions)}`,
    ...(goal.actioTaskIds.length ? [`- Actio task: ${goal.actioTaskIds.map((id) => `actio:${id}`).join(", ")}`] : []),
    `- 締切: ${goal.date} の業務日 (${input.deadline})${input.nearDeadline ? " — 締切まで 30 分を切っています" : ""}`,
    ...(input.droppedPermissions.length
      ? [`投稿者の権限を超えるため、${input.droppedPermissions.map((key) => PERMISSION_LABELS[key]).join("・")} の許可は不可にしました (管理職以上が必要です)。`]
      : []),
    "読み違いがあれば、カードの停止ボタンで止めて投稿し直してください (登録済みのゴールは書き換えません)。",
  ].join("\n");
}

export function noGoalReply(date: string): string {
  return `${date} は「目標なし」として記録しました。今日の 9:00 の通知とまとめの記載は行いません。`;
}

export function reminderText(date: string): string[] {
  return [`${date} のデイリーゴールがまだありません。`, ...POSTING_GUIDE];
}
