/** @implements spec/feature/autonomous-work-continuation.md §2 — 人間のやることの質問リンク (human-todo-link-C-19) */
const SNOWFLAKE = /^\d{17,20}$/;

interface Ids { guildId?: string | null; channelId?: string | null; messageId?: string | null }

export default {
  post(result: unknown, ids: Ids): boolean {
    const valid = [ids.guildId, ids.channelId, ids.messageId].every((v) => typeof v === "string" && SNOWFLAKE.test(v));
    if (!valid) return result === null;
    return result === `https://discord.com/channels/${ids.guildId}/${ids.channelId}/${ids.messageId}`;
  },
};
