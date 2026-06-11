import { ChannelType, type Message } from "discord.js";
import type { ChatChannel, ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordConfigRepo, DiscordMessageMapRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { isControlTrigger, postControlPanel } from "./control.js";
import { metaKindToChatChannel, type MetaChannelKind } from "./types.js";
import { recordInjectAck } from "./inject-ack.js";
import { classifyReactionWorkflow, reactionAckText, type WorkflowAction, type ReactionWorkflowInput } from "../platform/reaction-workflow.js";

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
  /** standalone 絵文字 (🙏 等) を「直前メッセージへのリアクション」として扱うための解決系。 */
  chatRepo?: ChatRepo;
  messageMap?: DiscordMessageMapRepo;
  /** リアクションワークフロー (reactions.ts と同一 runner)。 未注入なら絵文字単発はスキップ。 */
  workflow?: {
    handle(input: ReactionWorkflowInput, onAccept?: (action: WorkflowAction) => void): Promise<void>;
  };
  /** ユーザ設定の 絵文字→アクション 上書き写像を live 解決する (単発絵文字の判定に使う)。 */
  resolveReactionMappings?: () => Record<string, WorkflowAction>;
}

/** 異体字セレクタ / ZWJ / 肌色修飾を含む「絵文字のみ」で構成された文字列か。 */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍)+$/u;

/**
 * メッセージ本文が「単発絵文字」(絵文字のみ、 短い) か。 該当アクションの無い単発絵文字を
 * 却下 (プロンプト不通過) するための判定。 通常文・絵文字混じり文は false。
 */
function isStandaloneEmoji(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 32 && EMOJI_ONLY.test(t) && /\p{Extended_Pictographic}/u.test(t);
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

  // 単発で投稿された絵文字 (🙏 / 🫶 等) は「直前メッセージへのリアクション」と同義に扱い、
  // inject / chat には載せずリアクションワークフローへ流す (返信なら参照先を対象に取る)。
  // 該当アクションの無い単発絵文字は却下し、 通常プロンプトとしても通さない。
  if (deps.workflow) {
    if (classifyReactionWorkflow(text, deps.resolveReactionMappings?.())) {
      if (await tryEmojiWorkflow(deps, msg, text, routeChannelId)) return;
    } else if (isStandaloneEmoji(text)) {
      deps.log.info(`ingress: standalone emoji "${text.trim()}" has no workflow action → reject (prompt not forwarded)`);
      return;
    }
  }

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
      // ✅ リアクションは「届いた」時点では付けない。 transcript が動いた
      // (= セッションが実際に読み込んで処理を始めた) タイミングで付けるため、
      // ここでは対象メッセージを保留登録するだけにする (bot の transcript.frame /
      // prompt ハンドラが takeInjectAck で取り出して付ける)。 Enter が送られず
      // 宙に浮いたケースでは transcript が動かないので ✅ が付かない = 見分けられる。
      recordInjectAck(sessionRow.session_id, msg.channelId, msg.id);
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

/**
 * 単発絵文字メッセージ → リアクションワークフロー。 対象 chat_messages を解決して
 * fire-and-forget で workflow.handle を呼ぶ。 対象が見つからなければ false (通常経路へ)。
 */
async function tryEmojiWorkflow(
  deps: IngressDeps,
  msg: Message,
  emoji: string,
  routeChannelId: string,
): Promise<boolean> {
  if (!deps.workflow) return false;
  const chatId = resolveEmojiTargetChatId(deps, msg, routeChannelId);
  if (chatId == null) {
    deps.log.info(`ingress: emoji "${emoji}" but no target message found channel=${msg.channelId}`);
    return false;
  }
  // 対象 chat_messages から本文 / session 文脈を解決して runner へ渡す
  // (runner は chat_messages 非依存になったため、 ここで取り出す)。
  const target = deps.chatRepo?.findById(chatId) ?? null;
  let repoPath: string | null = null;
  let sessionActive = false;
  let sessionId: string | null = null;
  if (target?.session_id) {
    sessionId = target.session_id;
    const s = deps.sessionsRepo.findSession(target.session_id);
    if (s) {
      repoPath = s.repo_path;
      sessionActive = s.status === "active";
    }
  }
  deps.log.info(`ingress: emoji "${emoji}" → reaction-workflow chat_messages.id=${chatId} channel=${msg.channelId}`);
  void deps.workflow
    .handle(
      {
        dedupeKey: `chat:${chatId}`,
        emoji,
        userId: msg.author.id,
        messageText: target?.text ?? "",
        authorLabel: target?.author_label ?? "unknown",
        repoPath,
        sessionActive,
        sessionId,
      },
      (action) => {
        // 単発絵文字メッセージ自身へ「受付」リプライを返して発火を可視化する。
        void msg
          .reply({ content: reactionAckText(action, emoji), allowedMentions: { repliedUser: false } })
          .catch((e) => deps.log.warn(`ingress: emoji ack reply failed: ${(e as Error).message}`));
      },
    )
    .catch((e) => deps.log.warn(`ingress: emoji workflow failed: ${(e as Error).message}`));
  return true;
}

/** 単発絵文字の対象メッセージ: 返信先 → session の直近 → meta channel の直近 の順で解決。 */
function resolveEmojiTargetChatId(deps: IngressDeps, msg: Message, routeChannelId: string): number | null {
  // 1. 返信メッセージなら参照先を対象に取る (リアクションと同義の最も明示的な指定)。
  const refId = msg.reference?.messageId;
  if (refId && deps.messageMap) {
    const id = deps.messageMap.findChatId(refId);
    if (id != null) return id;
  }
  // 2. session channel: そのセッションが書いた直近メッセージ。
  const sessionRow = deps.sessionChannelsRepo.findByChannelId(routeChannelId);
  if (sessionRow && deps.chatRepo) {
    const m = deps.chatRepo.latestForSession(sessionRow.session_id);
    if (m) return m.id;
  }
  // 3. meta channel (chitchat / consultation / 報告 / system): その channel の直近メッセージ。
  const kind = resolveMetaKind(deps.configRepo, routeChannelId);
  if (kind && deps.chatRepo) {
    const m = deps.chatRepo.list({ channel: metaKindToChatChannel(kind), limit: 1 })[0];
    if (m) return m.id;
  }
  return null;
}

function resolveMetaKind(configRepo: DiscordConfigRepo, channelId: string): MetaChannelKind | null {
  const map = configRepo.all();
  for (const k of ["chitchat", "consultation", "houkoku", "system"] as const) {
    if (map[`${k}_channel_id`] === channelId) return k;
  }
  return null;
}
