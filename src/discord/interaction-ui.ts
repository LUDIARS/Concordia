/**
 * Discord 操作面の共通描画・インタラクション部品 (embed + select menu + button)。
 *
 * **この形式の正本**。 操作面ごとに embed / ActionRow を組み立てるコードを書くと、
 * 見た目と customId の書式が画面ごとにずれて二重管理になる (W4 が潰しに来た問題)。
 * 画面側は「何を出したいか」を `PanelSpec` として宣言し、 Discord の型・上限・
 * customId の書式はすべてここが引き受ける。
 *
 * 使う側:
 *  - PR 提出 / マージの操作面 (`pr-panel.ts`)
 *  - リアクションワークフローのアクション選択・受付・結果 (`rwf-panel.ts`)
 *  - `/mmtask` の UI を実装中の別セッションもこれを採用して統合すること
 *    (二重実装を残さないため。 公開インタフェースはこのファイルの export がすべて)。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W4 (Discord UI は mmtask 形式に揃える)
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type APIEmbed,
  type MessageActionRowComponentBuilder,
} from "discord.js";

/** 画面の性格。 embed の色だけを決める (文言は画面側が持つ)。 */
export type PanelTone = "info" | "success" | "warning" | "danger";

const TONE_COLOR: Record<PanelTone, number> = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
};

export interface PanelField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface PanelSelectOption {
  value: string;
  label: string;
  description?: string;
  emoji?: string;
  default?: boolean;
}

export interface PanelSelect {
  customId: string;
  placeholder: string;
  options: PanelSelectOption[];
  disabled?: boolean;
}

export type PanelButtonStyle = "primary" | "secondary" | "success" | "danger";

const BUTTON_STYLE: Record<PanelButtonStyle, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export interface PanelButton {
  customId: string;
  label: string;
  style: PanelButtonStyle;
  emoji?: string;
  disabled?: boolean;
}

export interface PanelSpec {
  title: string;
  description?: string;
  fields?: PanelField[];
  footer?: string;
  tone?: PanelTone;
  /** 選択メニュー (1 つにつき 1 行を占める)。 */
  selects?: PanelSelect[];
  /** ボタン (5 個ごとに 1 行へ折り返す)。 */
  buttons?: PanelButton[];
}

/** そのまま `channel.send()` / `interaction.reply()` に渡せる形。 */
export interface RenderedPanel {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

// Discord の上限。 超えると API が 400 を返して投稿ごと消えるので、 描画側で吸収する。
const MAX_SELECT_OPTIONS = 25;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ACTION_ROWS = 5;
const MAX_EMBED_DESCRIPTION = 4000;
const MAX_FIELD_VALUE = 1024;

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 宣言された画面を Discord の embed + components に落とす。
 *
 * 上限超過は落とすのではなく削って通し、 **削ったことを footer に明記**する
 * (黙って消えると「押せるはずのボタンが無い」だけが残り、原因が追えない)。
 */
export function buildPanel(spec: PanelSpec): RenderedPanel {
  const notes: string[] = [];

  const embed = new EmbedBuilder()
    .setTitle(clipText(spec.title, 256))
    .setColor(TONE_COLOR[spec.tone ?? "info"]);
  if (spec.description) embed.setDescription(clipText(spec.description, MAX_EMBED_DESCRIPTION));
  for (const field of spec.fields ?? []) {
    embed.addFields({
      name: clipText(field.name, 256),
      value: clipText(field.value, MAX_FIELD_VALUE),
      inline: field.inline ?? false,
    });
  }

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (const select of spec.selects ?? []) {
    if (select.options.length === 0) {
      notes.push(`選択肢が無いため「${select.placeholder}」を出していません`);
      continue;
    }
    const shown = select.options.slice(0, MAX_SELECT_OPTIONS);
    if (shown.length < select.options.length) {
      notes.push(`「${select.placeholder}」は ${select.options.length - shown.length} 件を省略しています`);
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId(select.customId)
      .setPlaceholder(clipText(select.placeholder, 150))
      .setDisabled(select.disabled ?? false)
      .addOptions(shown.map(toSelectOption));
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu));
  }

  const buttons = spec.buttons ?? [];
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    const chunk = buttons.slice(i, i + MAX_BUTTONS_PER_ROW).map(toButton);
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(chunk));
  }

  const kept = rows.slice(0, MAX_ACTION_ROWS);
  if (kept.length < rows.length) {
    notes.push(`操作行が上限 (${MAX_ACTION_ROWS}) を超えたため ${rows.length - kept.length} 行を省略しています`);
  }

  const footerParts = [spec.footer, ...notes].filter((part): part is string => !!part);
  if (footerParts.length > 0) embed.setFooter({ text: clipText(footerParts.join(" / "), 2048) });

  return { embeds: [embed], components: kept };
}

function toSelectOption(option: PanelSelectOption): StringSelectMenuOptionBuilder {
  const builder = new StringSelectMenuOptionBuilder()
    .setValue(clipText(option.value, 100))
    .setLabel(clipText(option.label, 100))
    .setDefault(option.default ?? false);
  if (option.description) builder.setDescription(clipText(option.description, 100));
  if (option.emoji) builder.setEmoji(option.emoji);
  return builder;
}

function toButton(button: PanelButton): ButtonBuilder {
  const builder = new ButtonBuilder()
    .setCustomId(clipText(button.customId, 100))
    .setLabel(clipText(button.label, 80))
    .setStyle(BUTTON_STYLE[button.style])
    .setDisabled(button.disabled ?? false);
  if (button.emoji) builder.setEmoji(button.emoji);
  return builder;
}

/** テスト / ログ用に embed を素の JSON で見る。 */
export function panelEmbedJson(panel: RenderedPanel): APIEmbed[] {
  return panel.embeds.map((embed) => embed.toJSON());
}

// ─── customId の書式 ───────────────────────────────────────────────────────
//
// `<namespace>:<action>[:<param>…]`。 送る側と受ける側が同じ関数を使うことで書式ずれを防ぐ。
// パラメータに `:` は使えない (含まれていたら組み立て時に弾く — 黙って壊れた ID を出さない)。

const ID_SEPARATOR = ":";

export function encodePanelId(namespace: string, action: string, ...params: string[]): string {
  const parts = [namespace, action, ...params];
  for (const part of parts) {
    if (part.includes(ID_SEPARATOR)) {
      throw new Error(`panel customId parts must not contain "${ID_SEPARATOR}": ${part}`);
    }
  }
  return parts.join(ID_SEPARATOR);
}

export interface DecodedPanelId {
  action: string;
  params: string[];
}

/** 自分の namespace の customId だけを解釈する。 他画面のものは null (握らない)。 */
export function decodePanelId(customId: string, namespace: string): DecodedPanelId | null {
  const parts = customId.split(ID_SEPARATOR);
  if (parts.length < 2 || parts[0] !== namespace) return null;
  const action = parts[1];
  if (!action) return null;
  return { action, params: parts.slice(2) };
}
