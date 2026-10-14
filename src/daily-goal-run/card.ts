/**
 * デイリーゴールのカードと通知の表示モデル (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 4. カード (証跡 / 判定 / タイムライン) / 5. 不調の通知 / 6. カード表示 / 7. 9:00 の通知 / 8. まとめの投稿
 *
 * transport に依存しない文字列の束を作る。 Discord への描画と配達は discord/ が持つ。
 */

import { deadlineOf, describeDeadline } from "./business-day.js";
import { isNearDeadline } from "./deadline-policy.js";
import { RESULT_LABELS } from "./day-summary.js";
import { reminderText } from "./post-replies.js";
import { describeActioTasks, describePermissions } from "./labels.js";
import {
  OUTLOOK_LABELS,
  VERDICT_LABELS,
  isActiveGoal,
  type DailyGoal,
  type DailyGoalCheckpoint,
  type DailyGoalDay,
  type JournalState,
  type ProgressJudgment,
} from "./domain.js";
import type { TimelineEntry } from "./repository.js";

export interface DailyGoalCardView {
  title: string;
  statusLabel: string;
  header: string[];
  evidence: string[];
  /** 最後の判定 (状態・理由・受入条件ごとの見込み)。 */
  judgment: string[];
  /** 締切で残った受入条件、 旧方式のやり切りの残り・喪失。 */
  remaining: string[];
  timeline: string[];
  /** 停止ボタンを出すか (見守り中だけ)。 */
  stoppable: boolean;
}

const VERDICT_ICONS = { on_track: "🟢", behind: "🟡", stalled: "🔴" } as const;

export function statusLabel(goal: DailyGoal): string {
  switch (goal.status) {
    case "achieved": return "✅ 達成";
    case "exhausted": return "🏁 やり切り";
    case "stopped": return "⏹️ 停止";
    case "deadline": return "⏰ 締切";
    case "lost": return "⚠️ 喪失";
    case "confirmed":
    case "running": return "👀 見守り中";
  }
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 判定の行 (カードとまとめで共用)。 */
export function judgmentLines(judgment: ProgressJudgment): string[] {
  return [
    `${VERDICT_ICONS[judgment.verdict]} **${VERDICT_LABELS[judgment.verdict]}** — ${judgment.reason}`,
    ...judgment.acceptance.map((entry, i) => `${i + 1}. ${OUTLOOK_LABELS[entry.outlook]}: ${entry.item}${entry.refs.length ? ` (${entry.refs.join(", ")})` : ""}`),
  ];
}

export function buildGoalCard(input: {
  goal: DailyGoal; checkpoints: readonly DailyGoalCheckpoint[]; timeline: readonly TimelineEntry[];
  now: number; dayBoundary: string;
}): DailyGoalCardView {
  const { goal } = input;
  const last = [...input.checkpoints].reverse().find((cp) => cp.kind !== "skipped_waiting") ?? null;
  const lastJudged = [...input.checkpoints].reverse().find((cp) => cp.kind === "judgment" || cp.kind === "judge_failed") ?? null;
  const evidence = last
    ? [
        ...last.evidence.items.slice(-10).map((item) => `- ${item.summary}`),
        ...(last.evidence.items.length ? [] : ["- (証跡なし)"]),
        ...(last.evidence.unavailable.length ? [`- (未取得: ${last.evidence.unavailable.join(", ")})`] : []),
      ]
    : ["- まだ確認していません"];
  const judgment = !lastJudged
    ? ["- まだ判定していません"]
    : lastJudged.kind === "judge_failed" || !lastJudged.judgment
      ? [`- ${hhmm(lastJudged.at)} ❔ 判定できず${lastJudged.report ? ` (${lastJudged.report.slice(0, 200)})` : ""}。次の確認でまた試します`]
      : [`- ${hhmm(lastJudged.at)} の判定`, ...judgmentLines(lastJudged.judgment)];
  const remaining: string[] = [];
  if (goal.status === "exhausted") {
    for (const item of goal.remaining ?? []) {
      remaining.push(item.class === "unachievable"
        ? `- 達成不能: ${item.item} — ${item.reason}`
        : item.class === "human_judgment" ? `- 決めてほしい点: ${item.item}` : `- ${item.item}`);
    }
  }
  if (goal.status === "deadline") {
    for (const item of goal.acceptance) {
      if (!(goal.acceptanceProgress?.[item]?.length)) remaining.push(`- 締切までに証跡の無い受入条件: ${item}`);
    }
  }
  if (goal.status === "lost") remaining.push("- 旧方式の専用セッションを喪失しました");
  const active = isActiveGoal(goal);
  const deadline = describeDeadline(goal.date, input.dayBoundary);
  const minutesLeft = Math.max(0, Math.ceil((deadlineOf(goal.date, input.dayBoundary) - input.now) / 60_000));
  return {
    title: `デイリーゴール ${goal.date} / ${goal.project}`,
    statusLabel: statusLabel(goal),
    header: [
      `**ゴール**: ${goal.goalText}`,
      "**受入条件**:", ...goal.acceptance.map((item, i) => `${i + 1}. ${item}`),
      `**Actio task**: ${describeActioTasks(goal.actioTaskIds)}`,
      `**許可範囲**: ${describePermissions(goal.permissions)}`,
      `**登録**: <@${goal.confirmedBy.userId}> の投稿`,
      `**締切**: ${deadline}${active && isNearDeadline(goal.date, input.now, input.dayBoundary) ? ` — ⚠️ 締切まであと ${minutesLeft} 分` : ""}`,
    ],
    evidence,
    judgment,
    remaining,
    timeline: input.timeline.slice(-12).map((entry) => `${hhmm(entry.at)} ${entry.text}`),
    stoppable: active,
  };
}

/**
 * 不調の通知の本文 (mention は含めない。 配達側が構造化フィールドで投稿者 1 人に付ける)。
 * 状態・理由・危うい受入条件と、 カードへの案内だけを載せる。
 */
export function buildAlertText(goal: DailyGoal, judgment: ProgressJudgment, kind: "first" | "repeat"): string {
  const risky = judgment.acceptance.filter((entry) => entry.outlook === "at_risk" || entry.outlook === "unlikely");
  return [
    kind === "repeat"
      ? `デイリーゴール「${goal.goalText}」は 3 時間以上 **${VERDICT_LABELS[judgment.verdict]}** が続いています。`
      : `デイリーゴール「${goal.goalText}」の進み具合が **${VERDICT_LABELS[judgment.verdict]}** です。`,
    `理由: ${judgment.reason}`,
    ...(risky.length ? ["危うい受入条件:", ...risky.map((entry) => `- ${OUTLOOK_LABELS[entry.outlook]}: ${entry.item}`)] : []),
    "詳しくはカードを見てください。止める場合はカードの停止ボタンを押してください。",
  ].join("\n");
}

/** 9:00 の通知 (目標の無い日に 1 回)。 */
export function buildReminderView(date: string): { title: string; lines: string[] } {
  return { title: `デイリーゴール ${date} — 目標がまだありません`, lines: reminderText(date) };
}

export interface DaySummaryCardView {
  title: string;
  lines: string[];
  /** 再送ボタンを出すか (まとめを記載する日だけ)。 */
  resendable: boolean;
}

const JOURNAL_LABELS: Record<JournalState, string> = {
  none: "未記載 (記載待ち)", intent: "記載中", unknown: "結果を照合中", written: "記載済み", unwritten: "未記載 (再送します)", skipped: "記載しない日",
};

/** 4:00 のまとめ投稿: 要約と、 日記・ノートへのリンク (記載の状態)。 */
export function buildDaySummaryCard(day: DailyGoalDay, goals: readonly DailyGoal[]): DaySummaryCardView {
  const lines = goals.length
    ? [`ゴール ${goals.length} 件:`, ...goals.map((goal) => `- ${RESULT_LABELS[goal.status]}: ${goal.project} — ${goal.goalText}`)]
    : ["ゴールは登録されませんでした (未定義のまま締切の投稿だけ)。"];
  const diary = `- Memoria 日記 ${day.businessDate} の「デイリーゴール」節: ${JOURNAL_LABELS[day.diaryState]}${day.diaryUrl ? ` ${day.diaryUrl}` : ""}`;
  const note = `- ノート「${day.summaryTitle ?? `デイリーゴール ${day.businessDate}`}」: ${JOURNAL_LABELS[day.noteState]}${day.noteUrl ? ` ${day.noteUrl}` : ""}`;
  return {
    title: `デイリーゴール ${day.businessDate} のまとめ`,
    lines: [...lines, "**記載**:", diary, note, ...(day.error && (day.diaryState !== "written" || day.noteState !== "written") ? [`-# ${day.error.slice(0, 200)}`] : [])],
    resendable: day.closeState !== "skipped",
  };
}
