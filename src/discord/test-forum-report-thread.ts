/**
 * 審査レポートを Test Forum スレッドへ配送する Discord 側の実装。
 *
 * 受領は Cc の台帳が正本で、投稿には受領印・ハッシュを表示しない。 本文・添付からの
 * メンション通知は常に抑制する。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import { AttachmentBuilder, type AnyThreadChannel, type Message } from "discord.js";
import type { DiscordReviewReportReceiptsRepo } from "../db/discord-review-report-receipts-repo.js";
import type { ReviewDocument } from "./test-forum-report.js";
import { deliverReviewDocuments } from "./test-forum-report-delivery.js";
import {
  receiptHistoryWindow,
  settleReceipts,
  type ThreadReceiptLedger,
  type ThreadReportPost,
} from "./test-forum-report-receipts.js";

/** 2026-09-12 版の受領印。 取り込みのためだけに読み、新しい投稿には付けない。 */
const LEGACY_RECEIPT_PREFIX = "Revisor report • ";
const NO_MENTIONS = { parse: [] as never[] };
const HISTORY_PAGE_SIZE = 100;
const ATTACHMENT_READ_TIMEOUT_MS = 15_000;

function legacyReceiptKey(message: Message): string | null {
  for (const embed of message.embeds) {
    const footer = embed.footer?.text;
    if (!footer?.startsWith(LEGACY_RECEIPT_PREFIX)) continue;
    const key = footer.slice(LEGACY_RECEIPT_PREFIX.length);
    if (/^[0-9a-f]{64}$/.test(key)) return key;
  }
  return null;
}

async function readAttachmentText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ATTACHMENT_READ_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Discord report attachment could not be read (${response.status})`);
  return await response.text();
}

function reportPostOf(message: Message): ThreadReportPost {
  return {
    id: message.id,
    createdAtMs: message.createdTimestamp,
    content: message.content,
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name,
      size: attachment.size,
      readText: () => readAttachmentText(attachment.url),
    })),
    legacyReceiptKey: legacyReceiptKey(message),
  };
}

/** Only this Bot's posts count; user-supplied text cannot suppress or confirm reports. */
async function readBotPosts(thread: AnyThreadChannel, notBeforeMs: number): Promise<ThreadReportPost[]> {
  const botId = thread.client.user?.id;
  if (!botId) throw new Error("Discord review reporter is not authenticated");
  const posts: ThreadReportPost[] = [];
  let before: string | undefined;
  while (true) {
    const page = await thread.messages.fetch({ limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) });
    if (page.size === 0) break;
    for (const message of page.values()) {
      if (message.author.id === botId && message.createdTimestamp >= notBeforeMs) posts.push(reportPostOf(message));
    }
    const oldest = page.last();
    if (!oldest || oldest.id === before) throw new Error("Discord report history did not advance");
    before = oldest.id;
    if (page.size < HISTORY_PAGE_SIZE || oldest.createdTimestamp < notBeforeMs) break;
  }
  return posts;
}

function threadLedger(repo: DiscordReviewReportReceiptsRepo, threadId: string): ThreadReceiptLedger {
  return {
    list: () => repo.list(threadId).map((row) => ({
      key: row.report_key,
      state: row.state,
      messageId: row.message_id,
      attemptedAtMs: row.attempted_at,
    })),
    legacyImported: () => repo.hasImportedLegacyReceipts(threadId),
    importLegacy: (keys) => repo.importLegacyReceipts(threadId, keys),
    markPending: (key, attemptedAtMs) => repo.markPending(threadId, key, attemptedAtMs),
    markDelivered: (key, messageId) => repo.markDelivered(threadId, key, messageId),
    forget: (key) => repo.forgetPending(threadId, key),
  };
}

export async function postReviewDocuments(
  thread: AnyThreadChannel,
  documents: readonly ReviewDocument[],
  receipts: DiscordReviewReportReceiptsRepo,
  nowMs: () => number = () => Date.now(),
): Promise<void> {
  const ledger = threadLedger(receipts, thread.id);
  await deliverReviewDocuments(documents, {
    readReceipts: async (messages) => {
      const recorded = ledger.list();
      const legacyImported = ledger.legacyImported();
      const window = receiptHistoryWindow(recorded, legacyImported);
      const history = window ? await readBotPosts(thread, window.notBeforeMs) : null;
      return await settleReceipts({ messages, receipts: recorded, legacyImported, history, ledger });
    },
    send: async (message) => {
      ledger.markPending(message.key, nowMs());
      const sent = await thread.send({
        content: message.content,
        allowedMentions: NO_MENTIONS,
        // Discord also deduplicates immediate retries when an accepted send lost its response.
        nonce: message.key.slice(0, 24),
        enforceNonce: true,
        ...(message.attachment ? { files: [new AttachmentBuilder(
          Buffer.from(message.attachment.text, "utf8"), { name: message.attachment.name },
        )] } : {}),
      });
      ledger.markDelivered(message.key, sent.id);
    },
  });
}
