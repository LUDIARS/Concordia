/**
 * 審査レポートの配送受領を、Cc の台帳と Discord のスレッド履歴で確定するロジック。
 *
 * - 送信の直前に台帳へ pending を書き、送信の応答で delivered へ進める。
 * - 応答を失った pending (再起動・通信断) は、送信時刻以降の Bot 投稿と本文・添付全文が
 *   一致するかで照合する。 見つからなければ pending を捨て、次の送信でやり直す。
 * - スレッドを初めて扱うときだけ旧版の footer 受領印を取り込み、取り込んだ受領と完了印を
 *   1 transaction で記録する (途中で落ちても部分的な取り込みを完了扱いにしない)。
 *
 * 受領印を投稿へ表示しないため、nonce による短期の重複抑止だけに頼らない。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import type { ReviewReportMessage } from "./test-forum-report-delivery.js";

export interface ReportReceipt {
  key: string;
  state: "pending" | "delivered";
  messageId: string | null;
  attemptedAtMs: number;
}

export interface ThreadReportAttachment {
  name: string;
  /** Discord が報告するバイト数。 */
  size: number;
  /** 照合が必要なときだけ本文を取得する。 読めなければ throw する。 */
  readText(): Promise<string>;
}

/** 照合に使う Bot 投稿の要約。 */
export interface ThreadReportPost {
  id: string;
  createdAtMs: number;
  content: string;
  attachments: readonly ThreadReportAttachment[];
  /** 旧版 footer の受領鍵。 */
  legacyReceiptKey: string | null;
}

export interface ThreadReceiptLedger {
  list(): ReportReceipt[];
  /** 旧版 footer 受領印の取り込みを完了したスレッドか。 */
  legacyImported(): boolean;
  /** 旧受領印で配送済みと確認した鍵と、取り込み完了を原子的に記録する。 */
  importLegacy(keys: readonly string[]): void;
  markPending(key: string, attemptedAtMs: number): void;
  markDelivered(key: string, messageId: string | null): void;
  forget(key: string): void;
}

/** 送信直前に記録した時刻と Discord の投稿時刻のずれの許容幅。 */
export const RECEIPT_CLOCK_SKEW_MS = 2 * 60 * 1000;

/**
 * 照合のために読む履歴の範囲。 null は履歴を読まなくてよい。
 * 旧受領印を取り込んでいないスレッドは全履歴 (notBeforeMs = 0) を読む。
 */
export function receiptHistoryWindow(
  receipts: readonly ReportReceipt[],
  legacyImported: boolean,
): { notBeforeMs: number } | null {
  if (!legacyImported) return { notBeforeMs: 0 };
  const pending = receipts.filter((receipt) => receipt.state === "pending");
  if (pending.length === 0) return null;
  const earliest = Math.min(...pending.map((receipt) => receipt.attemptedAtMs));
  return { notBeforeMs: Math.max(0, earliest - RECEIPT_CLOCK_SKEW_MS) };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function isSamePost(post: ThreadReportPost, message: ReviewReportMessage): Promise<boolean> {
  if (post.content.trim() !== message.content.trim()) return false;
  if (!message.attachment) return post.attachments.length === 0;
  const [attachment] = post.attachments;
  if (post.attachments.length !== 1 || !attachment) return false;
  if (attachment.name !== message.attachment.name || attachment.size !== utf8Length(message.attachment.text)) {
    return false;
  }
  // プレビューと大きさが同じでも後半の違う審査内容を、配送済みと取り違えない。
  return await attachment.readText() === message.attachment.text;
}

function importLegacyReceipts(
  messages: readonly ReviewReportMessage[],
  history: readonly ThreadReportPost[],
  delivered: Set<string>,
  ledger: ThreadReceiptLedger,
): void {
  const footers = new Set(history.flatMap((post) => (post.legacyReceiptKey ? [post.legacyReceiptKey] : [])));
  const imported = messages
    .filter((message) => !delivered.has(message.key)
      && message.legacyKeys.length > 0
      && message.legacyKeys.every((key) => footers.has(key)))
    .map((message) => message.key);
  ledger.importLegacy(imported);
  for (const key of imported) delivered.add(key);
}

export async function settleReceipts(input: {
  messages: readonly ReviewReportMessage[];
  receipts: readonly ReportReceipt[];
  legacyImported: boolean;
  /** null は履歴を読んでいない (照合不要)。 */
  history: readonly ThreadReportPost[] | null;
  ledger: ThreadReceiptLedger;
}): Promise<Set<string>> {
  const delivered = new Set(input.receipts
    .filter((receipt) => receipt.state === "delivered")
    .map((receipt) => receipt.key));
  const history = input.history;
  if (!history) return delivered;
  if (!input.legacyImported) importLegacyReceipts(input.messages, history, delivered, input.ledger);
  const messagesByKey = new Map(input.messages.map((message) => [message.key, message]));
  // 別の受領に結び付いた投稿を、同じ本文の別文書の証拠として二重に使わない。
  const claimedPosts = new Set(input.receipts.flatMap((receipt) => (receipt.messageId ? [receipt.messageId] : [])));
  for (const receipt of input.receipts) {
    if (receipt.state !== "pending") continue;
    const message = messagesByKey.get(receipt.key);
    let matched: ThreadReportPost | null = null;
    for (const post of message ? history : []) {
      if (claimedPosts.has(post.id) || post.createdAtMs < receipt.attemptedAtMs - RECEIPT_CLOCK_SKEW_MS) continue;
      if (message && await isSamePost(post, message)) {
        matched = post;
        break;
      }
    }
    if (matched) {
      claimedPosts.add(matched.id);
      input.ledger.markDelivered(receipt.key, matched.id);
      delivered.add(receipt.key);
    } else {
      // 投稿は届いていない (または今の文書に含まれない)。 送るなら pending からやり直す。
      input.ledger.forget(receipt.key);
    }
  }
  return delivered;
}
