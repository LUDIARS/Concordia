/**
 * ドメインレビューの指摘 (domain-note) をどのドメインへ渡すかの選択ダイアログ (spec domain-review-discord §4.2)。
 *
 * 返信本文の先頭指定でドメインが決まらなかったとき、 返信への応答として StringSelect を出す。
 * 選択肢 (ドメイン 24 件まで + プロジェクト全体) と送信結果は backend (`/v1/domain-review`) が決め、
 * ここは Discord API の生 JSON への描画と custom_id の解釈、 結果の文言だけを持つ (純関数)。
 */
import { sanitizeMentions } from "./embed-limits.js";

/** 選択メニュー: `drn:<answer_id>`、 値はドメイン id か `*` (プロジェクト全体)。 */
export const DOMAIN_REVIEW_NOTE_SELECT_PREFIX = "drn:";

/** backend の `note_delivery` 応答 (snake_case のまま受ける)。 */
export interface NoteDeliveryView {
  status: "sent" | "rejected" | "failed" | "awaiting_choice" | "sending";
  answer_id: number;
  domain_id?: string | null;
  proposal_id?: string;
  reason?: string;
  choices?: Array<{ value: string; label: string }>;
  omitted?: number;
}

export function isDomainReviewNoteCustomId(customId: string): boolean {
  return customId.startsWith(DOMAIN_REVIEW_NOTE_SELECT_PREFIX);
}

/** custom_id から回答 id を取り出す。 この選択メニューでなければ null。 */
export function parseDomainReviewNoteCustomId(customId: string): number | null {
  const match = /^drn:(\d+)$/.exec(customId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 選択ダイアログの部品。 選択肢が無ければ部品を出さない。 */
export function buildDomainReviewNoteComponents(delivery: NoteDeliveryView): Array<Record<string, unknown>> {
  const choices = (delivery.choices ?? []).slice(0, 25);
  if (delivery.status !== "awaiting_choice" || choices.length === 0) return [];
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `${DOMAIN_REVIEW_NOTE_SELECT_PREFIX}${delivery.answer_id}`,
      placeholder: "どのドメインへの指摘か選ぶ",
      min_values: 1,
      max_values: 1,
      options: choices.map((choice) => ({
        // ドメイン名は Anatomia 由来の信頼できない入力 (§2.5)。
        label: sanitizeMentions(choice.label).slice(0, 100) || choice.value.slice(0, 100),
        value: choice.value.slice(0, 100),
      })),
    }],
  }];
}

/** 返信・選択への応答文。 送れなかった理由は必ず書く (無言で捨てない)。 */
export function domainReviewNoteReplyText(delivery: NoteDeliveryView): string {
  const target = delivery.domain_id ? `ドメイン \`${sanitizeMentions(delivery.domain_id)}\`` : "プロジェクト全体";
  switch (delivery.status) {
    case "sent":
      return `ドメインへの指摘を記録し、${target}への指摘として Anatomia へ渡しました (提案 ${delivery.proposal_id ?? "-"}、Gate A の承認待ち)。`;
    case "rejected":
      return `ドメインへの指摘を記録しましたが、Anatomia が受け取りませんでした (${delivery.reason ?? "理由不明"})。`;
    case "failed":
      return `ドメインへの指摘を記録しましたが、Anatomia へは未送信です (${delivery.reason ?? "理由不明"})。`
        + ` 再試行: \`POST /v1/domain-review/answers/${delivery.answer_id}/note-delivery/retry\``;
    case "sending":
      return "ドメインへの指摘を記録しました (Anatomia へ送信中です)。";
    case "awaiting_choice": {
      const omitted = delivery.omitted ?? 0;
      return "ドメインへの指摘を記録しました。どのドメインへの指摘か選んでください。"
        + " 本文の先頭に `ドメイン名: ` を付けて返信すると選択を省けます。"
        + (omitted > 0 ? ` (ドメインが多いため ${omitted} 件は一覧に出していません。該当する場合は先頭指定で返信し直してください)` : "");
    }
  }
}

/** 選択後のメッセージ本文: 誰が何を選び、どうなったか。 */
export function domainReviewNoteChosenText(actorLabel: string, delivery: NoteDeliveryView): string {
  return `✅ ${sanitizeMentions(actorLabel)} が選択しました。${domainReviewNoteReplyText(delivery)}`;
}
