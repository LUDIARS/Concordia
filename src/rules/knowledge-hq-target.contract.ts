/** @implements spec/feature/patrol-chat.md — 知識の公開範囲と宛先 (chat-knowledge-C-2) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const t = args[0] as { subsidiaryId: string | null; scopeKey: string; discordChannelId: string | null };
    const headOfficeMeta = t.subsidiaryId === null && t.scopeKey === "hq" && t.discordChannelId === null;
    return result === headOfficeMeta;
  },
};
