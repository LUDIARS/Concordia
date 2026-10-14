/**
 * デイリーゴールのカードを Discord の message に描画する (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 4. カード (証跡 / 判定 / タイムライン) / 5. 不調の通知 / 7. 9:00 の通知 / 8. まとめの投稿 / CC-DG-INV-12
 *
 * 1 ゴール 1 message。 以後は同じ message を編集する。 末尾の marker で投稿を照合する。
 * カードは mention を発火させない。 不調の通知だけが構造化フィールドで投稿者 1 人を mention する。
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { DailyGoalCardView, DaySummaryCardView } from "../daily-goal-run/card.js";

export const DAILY_GOAL_STOP_PREFIX = "dg:stop:";
export const DAILY_GOAL_RESEND_PREFIX = "dg:resend:";
const LIMIT = 1900;

export function cardMarker(cardId: string): string { return `daily-goal-card:${cardId}`; }

function clip(text: string, marker: string): string {
  const footer = `\n-# ${marker}`;
  return text.length + footer.length <= LIMIT ? text + footer : `${text.slice(0, LIMIT - footer.length - 2)}…${footer}`;
}

export function renderGoalCard(cardId: string, goalId: string, view: DailyGoalCardView) {
  const text = [
    `## ${view.title} — ${view.statusLabel}`,
    ...view.header,
    "### 証跡 (Cc が確認したもの)", ...view.evidence,
    "### 判定", ...view.judgment,
    ...(view.remaining.length ? ["### 残り", ...view.remaining] : []),
    "### タイムライン", ...(view.timeline.length ? view.timeline.map((line) => `- ${line}`) : ["- (まだありません)"]),
  ].join("\n");
  const components = view.stoppable
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${DAILY_GOAL_STOP_PREFIX}${goalId}`).setLabel("停止する").setStyle(ButtonStyle.Danger))]
    : [];
  return { content: clip(text, cardMarker(cardId)), components, allowedMentions: { parse: [] as [] } };
}

/** 9:00 の通知。 ボタンは持たない。 */
export function renderReminderCard(cardId: string, view: { title: string; lines: string[] }) {
  return { content: clip([`## ${view.title}`, ...view.lines].join("\n"), cardMarker(cardId)), components: [], allowedMentions: { parse: [] as [] } };
}

/** 4:00 のまとめ。 記載する日は再送ボタン (本人確認 + session_control) を付ける。 */
export function renderDaySummaryCard(cardId: string, date: string, view: DaySummaryCardView) {
  const components = view.resendable
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${DAILY_GOAL_RESEND_PREFIX}${date}`).setLabel("日記・ノートへ再送").setStyle(ButtonStyle.Secondary))]
    : [];
  return { content: clip([`## ${view.title}`, ...view.lines].join("\n"), cardMarker(cardId)), components, allowedMentions: { parse: [] as [] } };
}

/** 判定文に含まれうる mention 記法を無害化する (allowedMentions と二重に防ぐ)。 */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(everyone|here)/g, "@\u200b$1").replace(/<@([!&]?)(\d+)>/g, "<@\u200b$1$2>");
}

/**
 * 不調の通知。 投稿者 1 人だけを構造化フィールドで mention し、 本文由来の mention は発火させない。
 * スレッドへ送るときもカードへの返信で送るときも同じ形。 返信先の作者への ping はしない。
 */
export function renderProgressAlert(mentionUserId: string, text: string) {
  return {
    content: `<@${mentionUserId}> ${neutralizeMentions(text)}`.slice(0, LIMIT),
    allowedMentions: { users: [mentionUserId], repliedUser: false },
  };
}
