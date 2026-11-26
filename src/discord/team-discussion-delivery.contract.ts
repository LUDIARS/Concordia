import type { MessageCreateOptions } from "discord.js";

export default {
  post(value: MessageCreateOptions, channelId: string, through: string, part: number, content: string): boolean {
    return !!channelId && !!through && Number.isInteger(part) && part >= 0
      && value.content === content && content.length > 0 && content.length <= 2000
      && value.allowedMentions?.parse?.length === 0 && value.enforceNonce === true
      && typeof value.nonce === "string" && /^[a-f0-9]{24}$/.test(value.nonce);
  },
};
