// Discord MessageCreate → POST /v1/chat (loopback) もしくは silent ignore.
//
// PR-A では:
//   - bot 自身の投稿は無視
//   - meta channel (chitchat / consultation / houkoku / system) での投稿 → /v1/chat
//   - session channel での投稿 → 案内 reply (slash command を使うよう促す。 PR-B で /inject 実装)
//
// 認証: なし (Discord の channel permissions に依存).

import { ChannelType, type Message } from "discord.js";
import type { ChatChannel } from "../db/chat-repo.js";
import type {
  DiscordConfigRepo,
  DiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import { metaKindToChatChannel, type MetaChannelKind } from "./types.js";

export interface IngressDeps {
  configRepo: DiscordConfigRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  /** Loopback Concordia API URL. 既定 http://127.0.0.1:<port>. */
  concordiaUrl: string;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export async function handleMessage(deps: IngressDeps, msg: Message): Promise<void> {
  if (msg.author.bot) return;                      // bot / webhook の投稿は無視
  if (!msg.guildId) return;                        // DM は対象外
  if (msg.channel.type !== ChannelType.GuildText) return;
  if (!msg.content.trim()) return;

  const channelId = msg.channelId;

  // session channel での投稿 → PR-A では案内のみ
  const sessionRow = deps.sessionChannelsRepo.findByChannelId(channelId);
  if (sessionRow) {
    try {
      await msg.reply({
        content:
          "session channel への指示は slash command 経由になります (PR-B 実装予定: `/inject <text>`)。 雑談は #chitchat / 相談は #consultation を使ってください。",
        allowedMentions: { repliedUser: false },
      });
    } catch { /* ignore */ }
    return;
  }

  // meta channel ?
  const kind = resolveMetaKind(deps.configRepo, channelId);
  if (!kind) return;

  const chatChannel = metaKindToChatChannel(kind);
  const author = msg.member?.nickname?.trim() || msg.author.username;
  try {
    const res = await fetch(`${deps.concordiaUrl}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: chatChannel satisfies ChatChannel,
        text: msg.content.trim().slice(0, 2000),
        author_label: author,
        metadata: { source: "discord", discord_user_id: msg.author.id, discord_message_id: msg.id },
      }),
    });
    if (!res.ok) {
      deps.log.warn(`ingress: /v1/chat returned ${res.status}`);
      return;
    }
  } catch (e) {
    deps.log.warn(`ingress: /v1/chat failed: ${(e as Error).message}`);
  }
}

function resolveMetaKind(configRepo: DiscordConfigRepo, channelId: string): MetaChannelKind | null {
  const map = configRepo.all();
  for (const k of ["chitchat", "consultation", "houkoku", "system"] as const) {
    if (map[`${k}_channel_id`] === channelId) return k;
  }
  return null;
}
