import type { TextChannel } from "discord.js";
import type { PrQueueSnapshot } from "../platform/chat-read-model.js";

const PR_QUEUE_MESSAGE_KEY = "pr_queue_status_message_id";

export async function upsertPrQueueChannelMessage(
  channel: TextChannel,
  snapshot: PrQueueSnapshot,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
): Promise<void> {
  const msgId = configGet(PR_QUEUE_MESSAGE_KEY);
  try {
    if (msgId) {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ content: snapshot.content });
      return;
    }
  } catch {
    // fall through and recreate
  }
  const sent = await channel.send({ content: snapshot.content });
  configSet(PR_QUEUE_MESSAGE_KEY, sent.id);
}
