/**
 * 本社: 拠点セッションの質問カード (SPEC-FED-SITE-FORUM-PARITY)。
 *
 * 2026-10-12 neco「本社と拠点で同じフォーラムとして投稿されるように / 通常のセッションと同じDiscordでの操作感にする」。
 * 拠点の質問は本社では文字だけで、 ボタンが出ずに答えられなかった。 通常の質問カード (question.ts) と同じ形
 * (埋め込み + 選択肢コード付きボタン / 選択メニュー) で出し、 押された回答は連合 ingress の `answer` で拠点へ返す。
 * 質問の状態 (回答済みか) の正本は拠点にあるので、 本社は質問を保存しない。
 */
import { labelWithOptionCode } from "../shared/option-code.js";

/** 単一選択のボタン: `fq:<question_id>:<index>`。 */
export const FEDERATION_QUESTION_BUTTON_PREFIX = "fq:";
/** 選択メニュー (6 択以上・複数選択): `fqs:<question_id>`、 値は index。 */
export const FEDERATION_QUESTION_SELECT_PREFIX = "fqs:";

export interface FederationQuestionCard {
  question_id: number;
  prompt: string;
  options: Array<{ label: string; description?: string }>;
  multi_select?: boolean;
}

/** webhook で送る質問カードの本体 (Discord API の生 JSON。 webhook は SDK の builder を要しない)。 */
export function buildFederationQuestionMessage(card: FederationQuestionCard): {
  embeds: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
} {
  const embed = {
    title: "AskUserQuestion",
    description: card.prompt.slice(0, 4_000),
    fields: card.options.slice(0, 25).map((option, index) => ({
      name: labelWithOptionCode(index, option.label).slice(0, 256),
      value: (option.description?.trim() || "—").slice(0, 1_024),
    })),
    footer: { text: `question_id=${card.question_id} · 自由に答えるときはこの投稿に返信してください` },
    color: 0xf1c40f,
  };
  return { embeds: [embed], components: buildFederationQuestionComponents(card) };
}

export function buildFederationQuestionComponents(card: FederationQuestionCard): Array<Record<string, unknown>> {
  const options = card.options.slice(0, 25);
  if (options.length === 0) return [];
  if (!card.multi_select && options.length <= 5) {
    return [{
      type: 1,
      components: options.map((option, index) => ({
        type: 2,
        style: 2,
        custom_id: `${FEDERATION_QUESTION_BUTTON_PREFIX}${card.question_id}:${index}`,
        label: labelWithOptionCode(index, option.label).slice(0, 80),
      })),
    }];
  }
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `${FEDERATION_QUESTION_SELECT_PREFIX}${card.question_id}`,
      placeholder: card.multi_select ? "複数選択して送信" : "回答を選ぶ",
      min_values: 1,
      max_values: card.multi_select ? options.length : 1,
      options: options.map((option, index) => ({
        label: labelWithOptionCode(index, option.label).slice(0, 100),
        value: String(index),
        ...(option.description?.trim() ? { description: option.description.trim().slice(0, 100) } : {}),
      })),
    }],
  }];
}

/** 押されたボタン / 選んだ値を回答にする。 本社の質問カードでなければ null。 */
export function parseFederationQuestionAnswer(
  customId: string,
  values: readonly string[] = [],
): { question_id: number; option_indexes: number[] } | null {
  const button = /^fq:(\d+):(\d+)$/.exec(customId);
  if (button) return { question_id: Number(button[1]), option_indexes: [Number(button[2])] };
  const select = /^fqs:(\d+)$/.exec(customId);
  if (!select) return null;
  const indexes = [...new Set(values.map(Number))].filter((value) => Number.isInteger(value) && value >= 0 && value < 25);
  return indexes.length > 0 ? { question_id: Number(select[1]), option_indexes: indexes } : null;
}

export function isFederationQuestionCustomId(customId: string): boolean {
  return customId.startsWith(FEDERATION_QUESTION_BUTTON_PREFIX) || customId.startsWith(FEDERATION_QUESTION_SELECT_PREFIX);
}

/** 選んだ選択肢の表示名 (コード `[A] ` を外す)。 拠点へ回答の本文として渡す。 */
export function stripOptionCode(label: string): string {
  return label.replace(/^\[[A-Z0-9]+\]\s*/, "").trim();
}

/** 押した後のカード本文: ボタンを外し、 誰が何を選んだかを残す (通常カードの解決と同じ見え方)。 */
export function answeredNotice(authorLabel: string, labels: readonly string[]): string {
  return `✅ ${authorLabel} が回答しました: ${labels.join(" / ")}`;
}

/**
 * 拠点: 本社から起動したセッションの質問は、 拠点の Discord では依頼者をメンションしない。
 * メンションは起動した側 (本社の投稿) にだけ付ける (2026-10-12 neco「メンションは起動したほうにつける」)。
 */
export function withoutRequesterMention<T extends { requester_platform?: "discord" | "slack"; requester_user_id?: string }>(
  event: T,
  suppress: boolean,
): T {
  if (!suppress) return event;
  const { requester_platform: _platform, requester_user_id: _user, ...rest } = event;
  return rest as T;
}
