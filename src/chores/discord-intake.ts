export interface ChoreDiscordAddress {
  guildId: string | null;
  channelId: string;
  parentId: string | null;
  messageId: string;
  isThread: boolean;
}

/** A forum starter is one request; discussion replies do not launch additional work.
 * @implements CC-CHORES-FORUM AT-01 AT-02 AT-03
 */
export function isChoreDiscordIntake(input: ChoreDiscordAddress, target: {
  guildId: string; windowId: string; forumId: string;
}): boolean {
  if (input.guildId !== target.guildId) return false;
  if (input.channelId === target.windowId && !input.isThread) return true;
  return input.isThread && input.parentId === target.forumId && input.messageId === input.channelId;
}

/** The external acceptance identity stays tied to the human's original message. */
export function choreDiscordRequestKey(input: Pick<ChoreDiscordAddress, "guildId" | "messageId">): string {
  if (!input.guildId || !input.messageId) throw new Error("Discord chores request requires a guild and message");
  return `discord:${input.guildId}:${input.messageId}`;
}
