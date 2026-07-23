import type { WebhookMessageCreateOptions } from "discord.js";

export function buildTaskflowDecisionMessage(input: {
  text: string;
  mentionUserId: string | null;
}): WebhookMessageCreateOptions {
  const mention = input.mentionUserId ? `<@${input.mentionUserId}> ` : "";
  return {
    content: `${mention}${input.text}`.slice(0, 1900),
    username: "Cc taskflow",
    allowedMentions: input.mentionUserId
      ? { parse: [], users: [input.mentionUserId] }
      : { parse: [] },
  };
}
