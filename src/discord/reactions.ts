// Discord MessageReactionAdd / Remove → chat_message_reactions に記録.
//
// 解決経路:
//   Discord message_id → discord_message_map → chat_messages.id
//   emoji の文字列 → fine / bad / raw:<emoji>
//
// 自分の bot が付けたリアクション (起動時の guidance 用等) は無視する.

import type {
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
} from "discord.js";
import {
  classifyEmoji,
  type ChatMessageReactionsRepo,
  type DiscordMessageMapRepo,
} from "../db/discord-repo.js";

export interface ReactionsDeps {
  reactionsRepo: ChatMessageReactionsRepo;
  messageMap: DiscordMessageMapRepo;
  log: { info: (m: string) => void };
  /**
   * リアクションを「指示」として処理に変換するワークフロー (任意)。 記録後に
   * fire-and-forget で呼ぶ。 未注入 (= deps に無い) なら従来通り記録のみ。
   */
  workflow?: { handle(input: { chatId: number; emoji: string; userId: string }): Promise<void> };
}

export async function handleReactionAdd(
  deps: ReactionsDeps,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;

  // Partial の場合は fetch (cache 外の古いメッセージ)
  let r = reaction;
  if (r.partial) {
    try { r = await r.fetch(); } catch { return; }
  }
  const emoji = r.emoji.name ?? r.emoji.toString();
  if (!emoji) return;

  const discordMessageId = r.message.id;
  const chatId = deps.messageMap.findChatId(discordMessageId);
  if (chatId == null) return;        // bot 投稿でない (= 内部 chat_messages に無い) 場合は記録しない

  const kind = classifyEmoji(emoji);
  deps.reactionsRepo.add({
    message_id: chatId,
    discord_user_id: user.id,
    kind,
  });
  deps.log.info(`reactions: ${user.id} reacted ${kind} on chat_messages.id=${chatId}`);

  // 記録とは独立に、 リアクションを「指示」としてワークフローに流す (fire-and-forget)。
  if (deps.workflow) {
    void deps.workflow
      .handle({ chatId, emoji, userId: user.id })
      .catch((e) => deps.log.info(`reactions: workflow failed: ${(e as Error).message}`));
  }
}

export async function handleReactionRemove(
  deps: ReactionsDeps,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;
  let r = reaction;
  if (r.partial) {
    try { r = await r.fetch(); } catch { return; }
  }
  const emoji = r.emoji.name ?? r.emoji.toString();
  if (!emoji) return;

  const chatId = deps.messageMap.findChatId(r.message.id);
  if (chatId == null) return;
  deps.reactionsRepo.remove({
    message_id: chatId,
    discord_user_id: user.id,
    kind: classifyEmoji(emoji),
  });
}
