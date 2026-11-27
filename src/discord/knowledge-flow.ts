import { ChannelType, PermissionFlagsBits, type Client, type Message, type PartialMessage } from "discord.js";
import type { Database } from "better-sqlite3";
import { createArticleInbox } from "../knowledge-flow/slack-receipt.js";
import { initializeLedger } from "../knowledge-flow/article-ledger.js";
import { startThreadDelivery } from "../knowledge-flow/thread-delivery.js";
import { parseWatchTarget, watchedChannels } from "../knowledge-flow/watched-channels.js";

export function discordArticleFlow(db: Database, client: Client, guild: string) {
  const subscriptions = watchedChannels(db);
  const prefix = "discord:" + guild + ":";
  const inbox = createArticleInbox(db, [], (team, channel) =>
    team === "discord:" + guild && channel.startsWith(prefix) && subscriptions.has("discord",guild,channel.slice(prefix.length)));
  initializeLedger(db);

  function monitored(message: Message | PartialMessage): string | null {
    if (message.guildId !== guild || !message.channel) return null;
    if (subscriptions.has("discord",guild,message.channelId)) return message.channelId;
    const channel = message.channel;
    return channel.isThread() && channel.type !== ChannelType.PrivateThread && channel.parentId && subscriptions.has("discord",guild,channel.parentId) ? channel.parentId : null;
  }

  return {
    monitored,
    receive(message: Message, old?: Message | PartialMessage) {
      if (!message.author || message.author.bot || message.webhookId || !message.content) return;
      const watch = monitored(message);
      if (!watch) return;
      const post = { ts: message.id, text: message.content, user: message.author.id,
        thread_ts: message.channel.isThread() ? "thread:"+message.channelId : "post:"+message.channelId+":"+message.id };
      const event = old ? {subtype:"message_changed",message:post,previous_message:{text:old.content??""}} : post;
      inbox("discord:"+guild, message.id+":"+(message.editedTimestamp??"new"), {...event,channel:prefix+watch},client.user?.id??null);
    },
    async command(message: Message): Promise<void> {
      if (message.author.bot || message.webhookId) return;
      const match = /^ナレッジ監視\s+(登録|解除)(?:\s+(\S+))?\s*$/.exec(message.content);
      if (!match) return;
      if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await message.reply("監視先の変更にはサーバー管理権限が必要です。"); return;
      }
      const target = match[2] ? parseWatchTarget(match[2]) : {platform:"discord" as const,team:guild,channel:message.channelId};
      if (!target || target.platform!=="discord" || target.team!==guild) {
        await message.reply("このサーバーのチャンネルリンクを指定してください。"); return;
      }
      subscriptions.change(target,match[1]==="登録");
      await message.reply({content:"記事の監視を"+match[1]+"しました。 <#"+target.channel+">",allowedMentions:{parse:[]}});
    },
    startDelivery(warn: (message:string)=>void) {
      return startThreadDelivery(db,async (_channel, destination, text)=>{
        const [kind,channelId,messageId]=destination.split(":");
        const source=await client.channels.fetch(channelId);
        if (!source || !("guildId" in source) || source.guildId!==guild) throw new Error("Article reply channel unavailable");
        const options={content:text,allowedMentions:{parse:[] as never[]}};
        if (kind==="thread" && source.isThread()) {await source.send(options);return;}
        if (kind!=="post" || !source.isTextBased() || !("messages" in source)) throw new Error("Article thread unavailable");
        const post=await source.messages.fetch(messageId);
        const thread=post.thread ?? (post.hasThread ? await client.channels.fetch(post.id) : await post.startThread({name:"記事レビュー "+messageId}));
        if (!thread?.isThread() || thread.parentId!==channelId) throw new Error("Article thread unavailable");
        await thread.send(options);
      },warn,guild);
    }
  };
}
