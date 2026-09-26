import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Dialogue, Action, Projection } from "../sprint-dialogues/domain.js";

const phases: Record<Projection['phase'], string> = { planning: "計画", implementation: "実装", acceptance: "受入確認", retrospective: "振り返り", next_planning: "次スプリント計画" };
export const choiceLabels: Record<Action, string> = { approve: "承認・確定", reject: "差し戻す", hold: "保留する", resume: "保留を解除", resubmit: "修正を再提出" };
export function phaseNoticeText(p: Projection, origin: string): string {
  return [`**${p.sprintName.slice(0, 150)}: ${p.closed ? "完了・次スプリント開始済み" : phases[p.phase]}${p.held ? "（保留中）" : ""}** / 版 ${p.revision}`,
    p.reason.slice(0, 700), p.closed ? "このスプリントの確認は完了しました。" : "現在の確認カードから判断するか、このスレッドで相談してください。",
    new URL(p.actioPath, origin).href].join("\n\n");
}
export function sprintCard(dialogue: Dialogue, actioOrigin: string) {
  const p = dialogue.projection;
  const choices: Action[] = p.closed ? [] : p.held ? ["resume", "reject"] : p.phase === "implementation" ? ["resubmit", "reject", "hold"] : ["approve", "reject", "hold"];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...choices.map(a => new ButtonBuilder()
    .setCustomId(`sd:${dialogue.id}:${p.revision}:${a}`).setLabel(choiceLabels[a])
    .setStyle(a === "reject" ? ButtonStyle.Danger : a === "approve" || a === "resubmit" ? ButtonStyle.Primary : ButtonStyle.Secondary)));
  row.addComponents(new ButtonBuilder().setLabel("Actioで内容を確認").setStyle(ButtonStyle.Link).setURL(new URL(p.actioPath, actioOrigin).href));
  return { content: [
    `**${p.sprintName.slice(0, 150)} — ${p.closed ? "完了・次スプリント開始済み" : phases[p.phase]}${p.held ? "（保留中）" : ""}**`,
    `版 ${p.revision} / 確認対象 ${p.sourceFingerprint.slice(0, 40)}`,
    p.reason.slice(0, 200), p.summary.slice(0, 1000),
    p.closed ? "このスプリントの判断は完了しました。履歴と相談はこのスレッドに残ります。" : "相談はこのスレッドへ。決定はボタンから理由と対象を入力してください。Actioで本人とチーム権限を確認してから反映します。",
    `sprint-dialogue:${dialogue.id}`,
  ].filter(Boolean).join("\n\n"), components: [row], allowedMentions: { parse: [] as [] } };
}
