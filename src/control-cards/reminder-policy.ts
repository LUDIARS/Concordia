/**
 * 催促の要否・間隔・深夜帯と文面 (純関数)。催促を出すのは Cc (CC-V5-INV-05)。
 * - 同じカードへの催促は最短 30 分あける
 * - 深夜帯 (src/shared/quiet-hours.ts) は出さない
 * - メンションは担当者 1 人だけ (構造化フィールド)。本文の mention は無効化する
 *
 * @implements spec/feature/control-cards.md — 催促 (CC-V5-INV-05)
 */
import { clipText, DEFAULT_REMIND_AFTER_MS, type ControlCard } from "./card-domain.js";

export const REMINDER_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** 催促した後の次の予定 (捌きが変えなければ 24 時間後にもう一度)。 */
export const REMINDER_REPEAT_MS = DEFAULT_REMIND_AFTER_MS;

export type ReminderDecision =
  | { kind: "send" }
  | { kind: "skip"; reason: "closed" | "not_due" | "too_soon" | "quiet_hours" };

export function decideReminder(input: {
  card: Pick<ControlCard, "state" | "remind_at">;
  lastSentAt: number | null;
  nowMs: number;
  quiet: boolean;
}): ReminderDecision {
  if (input.card.state !== "open") return { kind: "skip", reason: "closed" };
  if (input.card.remind_at === null || input.card.remind_at > input.nowMs) return { kind: "skip", reason: "not_due" };
  if (input.lastSentAt !== null && input.nowMs - input.lastSentAt < REMINDER_MIN_INTERVAL_MS) return { kind: "skip", reason: "too_soon" };
  if (input.quiet) return { kind: "skip", reason: "quiet_hours" };
  return { kind: "send" };
}

/** 催促の後の次の予定。前回の送信から 30 分未満にはしない。 */
export function nextRemindAt(nowMs: number): number {
  return nowMs + Math.max(REMINDER_REPEAT_MS, REMINDER_MIN_INTERVAL_MS);
}

/** 本文中の mention (@everyone / @here / <@id> / <@&id> / <#id> は残す) を無効化する。 */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/<@[!&]?(\d+)>/g, "@​$1");
}

/** 担当者が Discord のユーザー ID ならメンション先にする。名前だけなら本文に名前を書く。 */
export function reminderMention(assignee: string | null): string | null {
  return assignee && /^[0-9]{17,20}$/.test(assignee) ? assignee : null;
}

export function renderReminder(card: Pick<ControlCard, "summary" | "reminder_text" | "project" | "link" | "assignee" | "card_kind">, nowMs: number, raisedAt: number): string {
  const kind = card.card_kind === "human_action" ? "人間のアクション" : "人間の判断";
  const hours = Math.max(0, Math.floor((nowMs - raisedAt) / 3_600_000));
  const assignee = card.assignee && !reminderMention(card.assignee) ? ` 担当: ${clipText(card.assignee, 100)}` : "";
  return neutralizeMentions([
    `⏰ 管制カードの催促 (${kind}、${hours} 時間経過${card.project ? `、${card.project}` : ""})${assignee}`,
    clipText(card.reminder_text ?? card.summary, 400),
    card.link ? `回答先: ${card.link}` : "",
  ].filter(Boolean).join("\n"));
}
