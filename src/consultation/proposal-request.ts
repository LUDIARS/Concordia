/**
 * `/consult wrap` でセッションへ渡す「公開候補づくり」の依頼文 (spec/feature/tech-consultation.md §5)。
 *
 * 候補は会話の転載ではなく書き直した要約で、 個人・社内固有・秘密・人の評価を含めない。
 * セッションは会話の文脈を持つので、 文面はセッションが作り Cc の API へ出す。 公開するかどうかは
 * 相談者本人がチャンネルのボタンで決める (CC-CONSULT-INV-04)。
 *
 * @implements SPEC-CONSULT-PUBLISH
 */

import { MAX_PUBLICATION_SUMMARY_CHARS, MAX_PUBLICATION_TITLE_CHARS } from "./publication-service.js";

export function buildProposalRequest(input: { sessionId: string; concordiaUrl: string }): string {
  const endpoint = `${input.concordiaUrl.replace(/\/+$/, "")}/v1/consultations/proposals`;
  return [
    "[公開候補の作成依頼 (Concordia)]",
    "この相談から、組織の全員に共有してよさそうな知見を「書き直した要約」として 1 件だけ作ってください。",
    "- 会話を転載しない。相談者や他の人が特定できる内容・社内固有の事情・秘密・人の評価に当たる内容は含めない。",
    `- 題名 (${MAX_PUBLICATION_TITLE_CHARS} 文字以内) と本文 (Markdown、段落は空行で区切る、${MAX_PUBLICATION_SUMMARY_CHARS} 文字以内) を作る。`,
    "- 共有に値する知見が無ければ作らず、その旨をこのチャンネルに返す。",
    "作ったら、次の JSON を POST してください (公開するかどうかは相談者本人がチャンネルのボタンで決めます):",
    `POST ${endpoint}`,
    JSON.stringify({ session_id: input.sessionId, title: "<題名>", summary: "<本文>" }),
  ].join("\n");
}
