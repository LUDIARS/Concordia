/**
 * `/bug report` のモーダル (対象プロジェクト・何が起きたか・再現手順・公開名) の面
 * (spec/feature/bug-bounty.md §3)。 形の組み立てと読み取りだけを持つ。 受付は bounty-flow.ts。
 *
 * @implements SPEC-BOUNTY-INTAKE
 */

import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { MAX_BOUNTY_PROJECT_CODE_CHARS, MAX_BOUNTY_TEXT_CHARS } from "../bounty/intake.js";
import { MAX_PUBLIC_NAME_CHARS } from "../bounty/reporter.js";

export const BOUNTY_CUSTOM_ID_PREFIX = "bounty:";
export const BOUNTY_REPORT_MODAL_ID = `${BOUNTY_CUSTOM_ID_PREFIX}modal:report`;

export interface BountyModalValues {
  project: string;
  what_happened: string;
  repro_steps: string;
  public_name: string;
}

const LABELS: Readonly<Record<keyof BountyModalValues, string>> = {
  project: "対象プロジェクト (コード。分からなければ空)",
  what_happened: "何が起きたか",
  repro_steps: "再現手順 (任意)",
  public_name: "公開名 (任意。空なら今の設定のまま)",
};

export function buildBountyModal(input: { project?: string | null; publicName?: string | null } = {}): ModalBuilder {
  const field = (
    id: keyof BountyModalValues,
    style: TextInputStyle,
    required: boolean,
    maxLength: number,
    placeholder: string,
    value?: string | null,
  ) => {
    const text = new TextInputBuilder()
      .setCustomId(id)
      .setLabel(LABELS[id])
      .setStyle(style)
      .setRequired(required)
      .setMaxLength(maxLength)
      .setPlaceholder(placeholder);
    const initial = value?.trim().slice(0, maxLength);
    if (initial) text.setValue(initial);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(text);
  };
  return new ModalBuilder()
    .setCustomId(BOUNTY_REPORT_MODAL_ID)
    .setTitle("バグ報告")
    .addComponents(
      field("project", TextInputStyle.Short, false, MAX_BOUNTY_PROJECT_CODE_CHARS, "例: Cc", input.project),
      field("what_happened", TextInputStyle.Paragraph, true, MAX_BOUNTY_TEXT_CHARS, "期待した動きと、実際に起きたこと"),
      field("repro_steps", TextInputStyle.Paragraph, false, MAX_BOUNTY_TEXT_CHARS, "どうすると起きるか"),
      field("public_name", TextInputStyle.Short, false, MAX_PUBLIC_NAME_CHARS, "公開面に出してよい名前 (未設定は「匿名」)", input.publicName),
    );
}

/** モーダル送信を読む。 この面のものでなければ null。 */
export function readBountyModal(interaction: {
  customId: string;
  fields: { getTextInputValue(customId: string): string };
}): BountyModalValues | null {
  if (interaction.customId !== BOUNTY_REPORT_MODAL_ID) return null;
  const read = (id: keyof BountyModalValues): string => {
    try {
      return interaction.fields.getTextInputValue(id).trim();
    } catch {
      // 任意項目が空で送られたときは入力欄自体が無いことがある。
      return "";
    }
  };
  return {
    project: read("project"),
    what_happened: read("what_happened"),
    repro_steps: read("repro_steps"),
    public_name: read("public_name"),
  };
}
