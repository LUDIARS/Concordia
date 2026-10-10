/**
 * デイリーゴールのカードを Discord の message に描画する (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — カード (証跡 / セッションの報告 / 人間判断 / タイムライン)
 *
 * 1 ゴール 1 message。 以後は同じ message を編集する。 末尾の marker で投稿を照合する。
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import type { DailyGoalCardView } from "../daily-goal-run/card.js";
import type { GoalCandidate } from "../daily-goal-run/domain.js";

export const DAILY_GOAL_STOP_PREFIX = "dg:stop:";
export const DAILY_GOAL_CANDIDATE_PREFIX = "dg:cand:";
export const DAILY_GOAL_CANDIDATE_MODAL_PREFIX = "dgm:";
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
    "### セッションの報告", ...view.report,
    "### 人間判断", ...view.humanJudgment,
    "### タイムライン", ...(view.timeline.length ? view.timeline.map((line) => `- ${line}`) : ["- (まだありません)"]),
  ].join("\n");
  const components = view.stoppable
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${DAILY_GOAL_STOP_PREFIX}${goalId}`).setLabel("停止する").setStyle(ButtonStyle.Danger))]
    : [];
  return { content: clip(text, cardMarker(cardId)), components, allowedMentions: { parse: [] as [] } };
}

export function renderCandidateCard(cardId: string, candidate: GoalCandidate, view: { title: string; lines: string[] }) {
  const text = [`## ${view.title}`, ...view.lines].join("\n");
  return {
    content: clip(text, cardMarker(cardId)),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DAILY_GOAL_CANDIDATE_PREFIX}${candidate.id}`).setLabel("この案で確定する…").setStyle(ButtonStyle.Primary))],
    allowedMentions: { parse: [] as [] },
  };
}

/** 候補から確定するモーダル。 /co-daily-goal と同じ項目を人間が書き直して確定する。 */
export function candidateModal(candidate: GoalCandidate): ModalBuilder {
  const input = (id: string, label: string, value: string, style: TextInputStyle, required: boolean) => {
    const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(2000);
    if (value) field.setValue(value.slice(0, 2000));
    return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
  };
  return new ModalBuilder().setCustomId(`${DAILY_GOAL_CANDIDATE_MODAL_PREFIX}${candidate.id}`).setTitle(`デイリーゴールの確定 (${candidate.project})`.slice(0, 45))
    .addComponents(
      input("goal", "ゴール文", candidate.suggestedGoal, TextInputStyle.Paragraph, true),
      input("acceptance", "受入条件 (1 行に 1 件)", candidate.suggestedAcceptance.join("\n"), TextInputStyle.Paragraph, true),
      input("actio_tasks", "対応する Actio task ID (空白区切り)", candidate.actioTaskIds.join(" "), TextInputStyle.Short, true),
      input("permissions", "許可範囲 (4 項目すべて yes/no)", "merge=no test=no service=no deploy=no", TextInputStyle.Short, true),
    );
}
