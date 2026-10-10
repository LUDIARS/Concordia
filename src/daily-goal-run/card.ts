/**
 * デイリーゴールのカード表示モデル (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 確認 (カードには 証跡 / セッションの報告 / 人間判断 を分けて載せる) / 6. カード表示 / 7. 9:00 の通知 / 8. まとめの投稿
 *
 * transport に依存しない文字列の束を作る。 Discord への描画と配達は discord/ が持つ。
 */

import { waitingMinutes } from "./checkpoint-policy.js";
import { deadlineOf, describeDeadline } from "./business-day.js";
import { isNearDeadline } from "./deadline-policy.js";
import { RESULT_LABELS } from "./day-summary.js";
import { reminderText } from "./post-replies.js";
import { describeActioTasks, describePermissions } from "./prompts.js";
import type { DailyGoal, DailyGoalCheckpoint, DailyGoalDay, JournalState } from "./domain.js";
import type { TimelineEntry } from "./repository.js";

export interface DailyGoalCardView {
  title: string;
  statusLabel: string;
  header: string[];
  evidence: string[];
  report: string[];
  humanJudgment: string[];
  timeline: string[];
  /** 停止ボタンを出すか (確定済み・継続中だけ)。 */
  stoppable: boolean;
}

export function statusLabel(goal: DailyGoal, waiting: boolean): string {
  switch (goal.status) {
    case "achieved": return "✅ 達成";
    case "exhausted": return "🏁 やり切り";
    case "stopped": return "⏹️ 停止";
    case "deadline": return "⏰ 締切";
    case "lost": return "⚠️ 喪失";
    case "confirmed": return goal.launchState === "unknown" ? "❔ 起動結果を照合中" : "🚀 起動中";
    case "running": return waiting ? "⏳ 回答待ち" : "▶️ 継続中";
  }
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function buildGoalCard(input: {
  goal: DailyGoal; checkpoints: readonly DailyGoalCheckpoint[]; timeline: readonly TimelineEntry[];
  waiting: boolean; now: number; dayBoundary: string;
}): DailyGoalCardView {
  const { goal } = input;
  const last = [...input.checkpoints].reverse().find((cp) => cp.kind !== "skipped_waiting") ?? null;
  const firstWait = (() => {
    let since: number | null = null;
    for (const cp of input.checkpoints) since = cp.kind === "skipped_waiting" ? (since ?? cp.at) : null;
    return since;
  })();
  const evidence = last
    ? [
        ...last.evidence.items.slice(-10).map((item) => `- ${item.summary}`),
        ...(last.evidence.unavailable.length ? [`- (未取得: ${last.evidence.unavailable.join(", ")})`] : []),
      ]
    : ["- まだ確認していません"];
  const reports = input.checkpoints.filter((cp) => cp.report).slice(-2).map((cp) => `- ${hhmm(cp.at)} ${cp.report!.slice(0, 300)}`);
  const human: string[] = [];
  if (goal.status === "running" && input.waiting) {
    human.push(`- 回答待ちです (${waitingMinutes(firstWait, input.now)} 分経過)。セッションのスレッドで回答してください`);
  }
  if (goal.status === "exhausted") {
    for (const item of goal.remaining ?? []) {
      human.push(item.class === "unachievable"
        ? `- 達成不能: ${item.item} — ${item.reason}`
        : item.class === "human_judgment" ? `- 決めてほしい点: ${item.item}` : `- ${item.item}`);
    }
  }
  if (goal.status === "deadline") {
    for (const item of goal.acceptance) {
      if (!(goal.acceptanceProgress?.[item]?.length)) human.push(`- 締切までに証跡の無い受入条件: ${item}`);
    }
  }
  if (goal.status === "lost") human.push("- 専用セッションを喪失しました。再開するかは人間が選んでください");
  const active = goal.status === "confirmed" || goal.status === "running";
  const deadline = describeDeadline(goal.date, input.dayBoundary);
  const minutesLeft = Math.max(0, Math.ceil((deadlineOf(goal.date, input.dayBoundary) - input.now) / 60_000));
  return {
    title: `デイリーゴール ${goal.date} / ${goal.project}`,
    statusLabel: statusLabel(goal, input.waiting),
    header: [
      `**ゴール**: ${goal.goalText}`,
      "**受入条件**:", ...goal.acceptance.map((item, i) => `${i + 1}. ${item}`),
      `**Actio task**: ${describeActioTasks(goal.actioTaskIds)}`,
      `**許可範囲**: ${describePermissions(goal.permissions)}`,
      `**登録**: <@${goal.confirmedBy.userId}> の投稿${goal.sessionId ? ` / セッション ${goal.sessionId}` : ""}`,
      `**締切**: ${deadline}${active && isNearDeadline(goal.date, input.now, input.dayBoundary) ? ` — ⚠️ 締切まであと ${minutesLeft} 分` : ""}`,
    ],
    evidence,
    report: reports.length ? reports : ["- (報告なし)"],
    humanJudgment: human.length ? human : ["- なし"],
    timeline: input.timeline.slice(-12).map((entry) => `${hhmm(entry.at)} ${entry.text}`),
    stoppable: active,
  };
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
