import { ChannelType, type Message } from "discord.js";
import type { ChatChannel } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordConfigRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { isControlTrigger, postControlPanel } from "./control.js";
import { metaKindToChatChannel, type MetaChannelKind } from "./types.js";

const COMMAND_LIST_KEYWORD = "コマンドリスト";
const COMMAND_LIST_TEXT = [
  "使用可能コマンド一覧",
  "- session channel では通常メッセージ送信 = inject",
  "- /inject: 明示的に inject したい場合のみ",
  "- /spawn: 新規セッション起動",
  "- /skill: スキル実行",
  "- /keys: キーシーケンス送信",
  "- /answer: pending question へ回答",
  "- /stat: 現在ステータス表示",
  "- /chitchat: chitchat へ投稿",
  "- /consultation: consultation へ投稿",
  "- /end-session: セッション終了",
  "- control / /control / コントロール: コントロールパネル表示",
].join("\n");

export interface IngressDeps {
  configRepo: DiscordConfigRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  sessionsRepo: SessionsRepo;
  concordiaUrl: string;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export async function handleMessage(deps: IngressDeps, msg: Message): Promise<void> {
  if (msg.author.bot) {
    deps.log.info(`ingress: skip bot message channel=${msg.channelId} author=${msg.author.id}`);
    return;
  }
  if (!msg.guildId) {
    deps.log.info(`ingress: skip non-guild message channel=${msg.channelId}`);
    return;
  }
  if (
    msg.channel.type !== ChannelType.GuildText &&
    msg.channel.type !== ChannelType.PublicThread &&
    msg.channel.type !== ChannelType.PrivateThread &&
    msg.channel.type !== ChannelType.AnnouncementThread
  ) {
    deps.log.info(`ingress: skip unsupported channel type=${ChannelType[msg.channel.type] ?? msg.channel.type} channel=${msg.channelId}`);
    return;
  }
  const text = msg.content.trim();
  if (!text) {
    deps.log.info(`ingress: skip empty content channel=${msg.channelId}`);
    return;
  }

  if (isControlTrigger(text)) {
    await postControlPanel(msg.channel, deps.sessionsRepo, deps.sessionChannelsRepo);
    deps.log.info(`ingress: control panel posted (channel=${msg.channelId})`);
    return;
  }
  if (text === COMMAND_LIST_KEYWORD) {
    await msg.channel.send(COMMAND_LIST_TEXT);
    deps.log.info(`ingress: command list posted (channel=${msg.channelId})`);
    return;
  }

  if (text.startsWith("//")) {
    deps.log.info(`ingress: skip comment message channel=${msg.channelId}`);
    return;
  }

  const routeChannelId = resolveRouteChannelId(msg);
  deps.log.info(
    `ingress: routing channel=${msg.channelId} route_channel=${routeChannelId} ` +
    `type=${ChannelType[msg.channel.type] ?? msg.channel.type}`,
  );
  const sessionRow = deps.sessionChannelsRepo.findByChannelId(routeChannelId);
  if (sessionRow) {
    deps.log.info(
      `ingress: session channel matched route_channel=${routeChannelId} ` +
      `session=${sessionRow.session_id} status=${sessionRow.status}`,
    );
    if (sessionRow.status !== "active") {
      try {
        await msg.reply({ content: `This session is ${sessionRow.status}; inject is disabled.`, allowedMentions: { repliedUser: false } });
      } catch {}
      return;
    }
    try {
      // Session channel の通常発言は /inject と等価に扱う。
      // author_label を付けて Concordia に participants 登録 + 相手PFミラーの発言者明示に使う。
      const injectAuthor = msg.member?.nickname?.trim() || msg.author.username;
      const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${sessionRow.session_id}/inject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: text.slice(0, 4000),
          source: `discord:${msg.author.id}:${msg.channelId}:${msg.id}`,
          author_label: injectAuthor,
        }),
      });
      if (!res.ok) {
        deps.log.warn(`ingress: inject failed status=${res.status} session=${sessionRow.session_id} channel=${msg.channelId}`);
        try { await msg.reply({ content: `inject failed (${res.status})`, allowedMentions: { repliedUser: false } }); } catch {}
        return;
      }
      // Codex は環境によって文字列 inject 後に Enter だけ追送しないと確定しない場合がある。
      // Discord session channel 経由の通常投稿では best-effort で改行 inject を追加する。
      const session = deps.sessionsRepo.findSession(sessionRow.session_id);
      if (session?.provider === "codex-cli") {
        try {
          await fetch(`${deps.concordiaUrl}/v1/sessions/${sessionRow.session_id}/inject`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "\n", source: "discord-enter-fallback" }),
          });
        } catch {
          // Enter fallback failure is non-fatal for main inject path.
        }
      }
      // 受領した指示そのものに ✅ リアクションを付けて「Concordia が受け取った」ことを可視化する。
      // best-effort — リアクション権限が無くても inject は成立しているので失敗は飲み込む。
      try {
        await msg.react("✅");
      } catch (e) {
        deps.log.warn(`ingress: react failed session=${sessionRow.session_id} channel=${msg.channelId}: ${(e as Error).message}`);
      }
      deps.log.info(`ingress: inject ok session=${sessionRow.session_id} channel=${msg.channelId} user=${msg.author.id}`);
    } catch (e) {
      deps.log.warn(`ingress: inject network error session=${sessionRow.session_id} channel=${msg.channelId}: ${(e as Error).message}`);
      try { await msg.reply({ content: `network error: ${(e as Error).message}`, allowedMentions: { repliedUser: false } }); } catch {}
    }
    return;
  }

  const kind = resolveMetaKind(deps.configRepo, routeChannelId);
  if (!kind) {
    deps.log.info(`ingress: no routing target for route_channel=${routeChannelId}; ignored`);
    return;
  }

  const chatChannel = metaKindToChatChannel(kind);
  const author = msg.member?.nickname?.trim() || msg.author.username;
  try {
    const res = await fetch(`${deps.concordiaUrl}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: chatChannel satisfies ChatChannel,
        text: text.slice(0, 2000),
        author_label: author,
        metadata: { source: "discord", discord_user_id: msg.author.id, discord_message_id: msg.id },
      }),
    });
    if (!res.ok) {
      deps.log.warn(`ingress: /v1/chat returned ${res.status} channel=${chatChannel} discord_channel=${msg.channelId}`);
      return;
    }
    deps.log.info(`ingress: /v1/chat ok channel=${chatChannel} discord_channel=${msg.channelId} user=${msg.author.id}`);
  } catch (e) {
    deps.log.warn(`ingress: /v1/chat failed discord_channel=${msg.channelId}: ${(e as Error).message}`);
  }
}

function resolveRouteChannelId(msg: Message): string {
  if (
    msg.channel.type === ChannelType.PublicThread ||
    msg.channel.type === ChannelType.PrivateThread ||
    msg.channel.type === ChannelType.AnnouncementThread
  ) {
    return msg.channel.parentId ?? msg.channelId;
  }
  return msg.channelId;
}

function resolveMetaKind(configRepo: DiscordConfigRepo, channelId: string): MetaChannelKind | null {
  const map = configRepo.all();
  for (const k of ["chitchat", "consultation", "houkoku", "system"] as const) {
    if (map[`${k}_channel_id`] === channelId) return k;
  }
  return null;
}
