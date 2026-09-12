/**
 * Discord history is the delivery receipt, including after an interrupted reconcile.
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import { AttachmentBuilder, type AnyThreadChannel } from "discord.js";
import { createHash } from "node:crypto";
import { splitReviewText, type ReviewDocument } from "./test-forum-report.js";

const RECEIPT_PREFIX = "Revisor report • ";
const NO_MENTIONS = { parse: [] as never[] };

export interface ReviewReportMessage {
  key: string;
  content: string;
  attachment?: { name: string; text: string };
}

export function reportMessages(documents: readonly ReviewDocument[]): ReviewReportMessage[] {
  return documents.flatMap((document) => splitReviewText(document.text).map((text, index, parts) => {
    const key = createHash("sha256").update(`${document.key}:${index}`).digest("hex");
    const title = splitReviewText(document.title, 200)[0].replace(/[\r\n]/g, " ");
    const heading = `**${title}**${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ""}`;
    if (text.length <= 1500) return { key, content: `${heading}\n${text}` };
    const preview = splitReviewText(text, 1200)[0];
    return {
      key,
      content: `${heading}\n${preview}\n\n📄 保持されている全文は添付のテキストで読めます。`,
      attachment: { name: `review-${key.slice(0, 16)}.txt`, text },
    };
  }));
}

export interface ReviewReportDelivery {
  /** Must finish reading receipts before sending anything; read failures are not empty history. */
  readReceipts(): Promise<ReadonlySet<string>>;
  send(message: ReviewReportMessage): Promise<void>;
}

export async function deliverReviewDocuments(
  documents: readonly ReviewDocument[],
  delivery: ReviewReportDelivery,
): Promise<void> {
  const receipts = new Set(await delivery.readReceipts());
  for (const message of reportMessages(documents)) {
    if (receipts.has(message.key)) continue;
    await delivery.send(message);
    receipts.add(message.key);
  }
}

/** Only receipts authored by this Bot count; user-supplied text cannot suppress reports. */
async function readReceipts(thread: AnyThreadChannel): Promise<Set<string>> {
  const receipts = new Set<string>();
  const botId = thread.client.user?.id;
  if (!botId) throw new Error("Discord review reporter is not authenticated");
  let before: string | undefined;
  while (true) {
    const page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (page.size === 0) break;
    for (const message of page.values()) {
      if (message.author.id !== botId) continue;
      for (const embed of message.embeds) {
        const footer = embed.footer?.text;
        if (footer?.startsWith(RECEIPT_PREFIX)) {
          const key = footer.slice(RECEIPT_PREFIX.length);
          if (/^[0-9a-f]{64}$/.test(key)) receipts.add(key);
        }
      }
    }
    const oldest = page.last()?.id;
    if (!oldest || oldest === before) throw new Error("Discord report history did not advance");
    before = oldest;
    if (page.size < 100) break;
  }
  return receipts;
}

export async function postReviewDocuments(
  thread: AnyThreadChannel,
  documents: readonly ReviewDocument[],
): Promise<void> {
  await deliverReviewDocuments(documents, {
    readReceipts: () => readReceipts(thread),
    send: async (message) => {
      await thread.send({
        content: message.content,
        embeds: [{ footer: { text: `${RECEIPT_PREFIX}${message.key}` } }],
        allowedMentions: NO_MENTIONS,
        // Discord also deduplicates immediate retries when an accepted send lost its response.
        nonce: message.key.slice(0, 24),
        enforceNonce: true,
        ...(message.attachment ? { files: [new AttachmentBuilder(
          Buffer.from(message.attachment.text, "utf8"), { name: message.attachment.name },
        )] } : {}),
      });
    },
  });
}
