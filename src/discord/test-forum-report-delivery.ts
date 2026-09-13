/**
 * 審査レポート文書を Discord 投稿へ分け、配送済みでないものだけを送る。
 *
 * 投稿には受領印・ハッシュを載せない。 受領の読み書きは {@link ReviewReportDelivery} の実装
 * (Cc の台帳と Discord スレッド履歴の照合、test-forum-report-thread.ts) が持つ。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import { createHash } from "node:crypto";
import type { ReviewDocument } from "./test-forum-report.js";
import { splitReviewText } from "./test-forum-report-split.js";

/** これを超える本文はプレビューにし、全文を UTF-8 テキストで添付する。 */
const INLINE_LIMIT = 1500;
const PREVIEW_LIMIT = 1200;

export interface ReviewReportMessage {
  /** 配送の同一性 (内部のみ)。 */
  key: string;
  /** 旧版の footer 受領印の鍵 (文書の全分割片)。 */
  legacyKeys: readonly string[];
  content: string;
  attachment?: { name: string; text: string };
}

export function reportMessages(documents: readonly ReviewDocument[]): ReviewReportMessage[] {
  return documents.flatMap((document) => splitReviewText(document.text).map((text, index, parts) => {
    const key = createHash("sha256").update(`${document.key}:${index}`).digest("hex");
    const title = splitReviewText(document.title, 200)[0].replace(/[\r\n]/g, " ");
    const heading = `**${title}**${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ""}`;
    const base = { key, legacyKeys: document.legacyMessageKeys };
    if (text.length <= INLINE_LIMIT) return { ...base, content: `${heading}\n${text}` };
    const preview = splitReviewText(text, PREVIEW_LIMIT)[0];
    return {
      ...base,
      content: `${heading}\n${preview}\n\n📄 続きを含む全文は添付のテキストで読めます。`,
      attachment: {
        name: `${document.fileStem}${parts.length > 1 ? `-${index + 1}` : ""}.txt`,
        text,
      },
    };
  }));
}

export interface ReviewReportDelivery {
  /** Must finish reading receipts before sending anything; read failures are not empty history. */
  readReceipts(messages: readonly ReviewReportMessage[]): Promise<ReadonlySet<string>>;
  send(message: ReviewReportMessage): Promise<void>;
}

export async function deliverReviewDocuments(
  documents: readonly ReviewDocument[],
  delivery: ReviewReportDelivery,
): Promise<void> {
  const messages = reportMessages(documents);
  const receipts = new Set(await delivery.readReceipts(messages));
  for (const message of messages) {
    if (receipts.has(message.key)) continue;
    await delivery.send(message);
    receipts.add(message.key);
  }
}
