/**
 * `/consult` のモーダル (事前ヒアリングの 4 項目) と承認ボタンの面 (spec/feature/tech-consultation.md §3 §4)。
 * 形の組み立てと読み取りだけを持つ。 受付の判断は consult-flow.ts。
 *
 * @implements SPEC-CONSULT-INTAKE
 * @implements SPEC-CONSULT-PRIVATE
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  CONSULT_INTAKE_LABELS,
  MAX_CONSULT_INTAKE_FIELD_CHARS,
  normalizeConsultIntake,
  type ConsultIntake,
  type ConsultIntakeDefaults,
} from "../dialogue/intake.js";

export const CONSULT_CUSTOM_ID_PREFIX = "consult:";
export const CONSULT_MODAL_PREFIX = `${CONSULT_CUSTOM_ID_PREFIX}modal:`;
export const CONSULT_APPROVE_PREFIX = `${CONSULT_CUSTOM_ID_PREFIX}approve:`;
/** 閉じた相談の再開・チャンネル削除 (相談者本人の操作、 tech-consultation.md §7)。 */
export const CONSULT_RESUME_PREFIX = `${CONSULT_CUSTOM_ID_PREFIX}resume:`;
export const CONSULT_DELETE_PREFIX = `${CONSULT_CUSTOM_ID_PREFIX}delete:`;

/** Discord のモーダル題名は 45 文字まで。 */
const MAX_MODAL_TITLE = 45;
/** Discord の短文入力の既定値・上限。 */
const MAX_SHORT_INPUT = 200;

export function isConsultCustomId(customId: string): boolean {
  return customId.startsWith(CONSULT_CUSTOM_ID_PREFIX);
}

export function buildConsultModal(input: {
  departmentId: string;
  departmentName: string;
  defaults?: ConsultIntakeDefaults | null;
}): ModalBuilder {
  const field = (id: keyof ConsultIntake, style: TextInputStyle, required: boolean, placeholder: string, value?: string) => {
    const text = new TextInputBuilder()
      .setCustomId(id)
      .setLabel(CONSULT_INTAKE_LABELS[id])
      .setStyle(style)
      .setRequired(required)
      .setPlaceholder(placeholder)
      .setMaxLength(style === TextInputStyle.Short ? MAX_SHORT_INPUT : MAX_CONSULT_INTAKE_FIELD_CHARS);
    const initial = value?.trim().slice(0, MAX_SHORT_INPUT);
    if (initial) text.setValue(initial);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(text);
  };
  return new ModalBuilder()
    .setCustomId(`${CONSULT_MODAL_PREFIX}${input.departmentId}`)
    .setTitle(`${input.departmentName}へのプライベート相談`.slice(0, MAX_MODAL_TITLE))
    .addComponents(
      field("topic", TextInputStyle.Paragraph, true, "何について知りたいか"),
      field("skill_level", TextInputStyle.Short, true, "初級 / 中級 / 上級、または経験年数", input.defaults?.skill_level),
      field("role_title", TextInputStyle.Short, true, "エンジニア / デザイナー / マネージャーなど", input.defaults?.role_title),
      field("purpose", TextInputStyle.Paragraph, false, "何のために知りたいか (知ること自体が目的でも構いません)"),
    );
}

/** モーダル送信を読む。 この面のものでなければ null。 */
export function readConsultModal(interaction: {
  customId: string;
  fields: { getTextInputValue(customId: string): string };
}): { departmentId: string; intake: ConsultIntake } | null {
  if (!interaction.customId.startsWith(CONSULT_MODAL_PREFIX)) return null;
  const departmentId = interaction.customId.slice(CONSULT_MODAL_PREFIX.length);
  if (!departmentId) return null;
  const read = (id: keyof ConsultIntake): string => {
    try {
      return interaction.fields.getTextInputValue(id);
    } catch {
      // 任意項目 (目的) が空で送られたときは入力欄自体が無いことがある。
      return "";
    }
  };
  return {
    departmentId,
    intake: normalizeConsultIntake({
      topic: read("topic"),
      skill_level: read("skill_level"),
      role_title: read("role_title"),
      purpose: read("purpose"),
    }),
  };
}

export function buildConsultApprovalRow(consultationId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONSULT_APPROVE_PREFIX}${consultationId}`)
      .setLabel("起動を承認")
      .setStyle(ButtonStyle.Primary),
  );
}

export function parseConsultApproval(customId: string): string | null {
  if (!customId.startsWith(CONSULT_APPROVE_PREFIX)) return null;
  return customId.slice(CONSULT_APPROVE_PREFIX.length) || null;
}

export function buildConsultClosedRow(consultationId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONSULT_RESUME_PREFIX}${consultationId}`).setLabel("セッションを再開").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${CONSULT_DELETE_PREFIX}${consultationId}`).setLabel("チャンネルを削除").setStyle(ButtonStyle.Danger),
  );
}

export function parseConsultLifecycle(customId: string): { action: "resume" | "delete"; consultationId: string } | null {
  const action = customId.startsWith(CONSULT_RESUME_PREFIX) ? "resume" : customId.startsWith(CONSULT_DELETE_PREFIX) ? "delete" : null;
  if (!action) return null;
  const consultationId = customId.slice((action === "resume" ? CONSULT_RESUME_PREFIX : CONSULT_DELETE_PREFIX).length);
  return consultationId ? { action, consultationId } : null;
}
