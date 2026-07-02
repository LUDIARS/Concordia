import { ChannelType, type Message } from "discord.js";
import type { ChatChannel, ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordConfigRepo, DiscordMessageMapRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { isControlTrigger, postControlPanel } from "./control.js";
import { metaKindToChatChannel, type MetaChannelKind } from "./types.js";
import { recordInjectAck } from "./inject-ack.js";
import { ENTER_KEY_TEXT } from "../control/enter-key.js";
import { type WorkflowAction, type ReactionWorkflowInput, type WorkflowResultRelay } from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import { maybeSpawnFromReply } from "./reply-spawn.js";

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
    handle(
      input: ReactionWorkflowInput,
      onAccept?: (action: WorkflowAction) => void,
      onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
    ): Promise<void>;
  };
  /** ユーザ設定の 絵文字→アクション 上書き写像を live 解決する (単発絵文字の判定に使う)。 */
  resolveReactionMappings?: () => Record<string, WorkflowAction>;
  /**
   * 子会社モード。 intake チャンネルの新規メッセージはガードゲートに通し (process)、
   * ロック済みユーザは他チャンネルでも遮断する。 spec/feature/subsidiary-delegation.md §3.1。
   */
  subsidiary?: {
    intakeChannelId: string | null;
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    isLocked: (userId: string) => boolean;
  };
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

  // 子会社モード: 受付チャンネルの新規依頼はガードゲートへ。 他チャンネルでもロック済みは遮断。
  if (deps.subsidiary) {
    const sub = deps.subsidiary;
    if (sub.intakeChannelId && routeChannelId === sub.intakeChannelId) {
      const userLabel = msg.member?.nickname?.trim() || msg.author.username;
      deps.log.info(`ingress: subsidiary intake request channel=${msg.channelId} user=${msg.author.id}`);
      try {
        const result = await sub.process(msg.author.id, userLabel, text.slice(0, 8000));
        await msg.reply({ content: result.replyText, allowedMentions: { parse: [], repliedUser: false } });
      } catch (e) {
        deps.log.warn(`ingress: subsidiary gate failed channel=${msg.channelId}: ${(e as Error).message}`);
        try { await msg.reply({ content: `⚠️ 内部エラーで処理できませんでした: ${(e as Error).message}`, allowedMentions: { parse: [], repliedUser: false } }); } catch {}
      }
      return;
    }
    if (sub.isLocked(msg.author.id)) {
      deps.log.info(`ingress: subsidiary locked user=${msg.author.id} channel=${msg.channelId}; blocked`);
      try { await msg.reply({ content: "🔒 ロック中のため処理できません。", allowedMentions: { parse: [], repliedUser: false } }); } catch {}
      return;
    }
  }

  // 単発で投稿された絵文字 (🙏 / 🫶 等) は「直前メッセージへのリアクション」と同義に扱い、
  // inject / chat には載せずリアクションワークフローへ流す (返信なら参照先を対象に取る)。
  // 該当アクションの無い単発絵文字は却下し、 通常プロンプトとしても通さない。
  if (deps.workflow) {
    if (getRwf().classifyReactionWorkflow(text, deps.resolveReactionMappings?.())) {
      if (await tryEmojiWorkflow(deps, msg, text, routeChannelId)) return;
    } else if (getRwf().isStandaloneEmoji(text)) {
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
    // 返信 (message reference あり) は走っているセッションへは inject しない。
    // 基本は「情報補足」で AI は反応せず、 モデル指定/作業指示を含む時だけ Haiku 判定で
    // 新規セッションを立てる (reply-spawn)。 通常 (非返信) メッセージは従来どおり inject。
    if (msg.reference?.messageId) {
      await handleSessionReply(deps, msg, sessionRow.session_id);
      return;
    }
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
            body: JSON.stringify({ text: ENTER_KEY_TEXT, source: "discord-enter-fallback" }),
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

/**
 * session channel への返信を処理する。 走っているセッションへは inject せず、
 * Haiku 判定でモデル指定/作業指示を含む時だけ新規セッションを spawn する。
 * 補足扱い (spawn なし) のときは AI は反応しない (Discord にも何も返さない)。
 */
async function handleSessionReply(deps: IngressDeps, msg: Message, sessionId: string): Promise<void> {
  const replyText = msg.content.trim();
  // 返信先メッセージ本文 (元の作業内容)。 取得失敗は空文字で続行 (返信本文だけで判定)。
  let repliedToText = "";
  try {
    const ref = await msg.fetchReference();
    repliedToText = ref?.content?.trim() ?? "";
  } catch {
    // 参照先が削除済 / 取得不可 → 空のまま。
  }
  const repoPath = deps.sessionsRepo.findSession(sessionId)?.repo_path ?? null;
  const concordiaUrl = deps.concordiaUrl;
  const result = await maybeSpawnFromReply(
    {
      log: deps.log,
      spawn: async (body) => {
        try {
          const res = await fetch(`${concordiaUrl}/v1/admin/spawn-session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    { replyText, repliedToText, repoPath },
  );
  // 起動した時だけ可視化する。 補足扱いは「AI 一切反応しない」ため無言。
  if (result.spawned) {
    try {
      await msg.reply({
        content: `🆕 返信内容で新規セッションを起動しました${result.model ? ` (model: ${result.model})` : ""}。`,
        allowedMentions: { repliedUser: false },
      });
    } catch { /* best-effort */ }
    // spawn した作業内容を session channel へ投稿して可視化する。
    if (result.spawnPrompt) {
      try {
        await fetch(`${deps.concordiaUrl}/v1/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: "報告",
            text: result.spawnPrompt.slice(0, 2000),
            author_label: "Concordia (spawn)",
            discord_channel_id: msg.channelId,
          }),
        });
      } catch { /* best-effort */ }
    }
  }
  deps.log.info(`ingress: session reply → reply-spawn spawned=${result.spawned} reason=${result.reason}`);
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
          .reply({ content: getRwf().reactionAckText(action, emoji), allowedMentions: { repliedUser: false } })
          .catch((e) => deps.log.warn(`ingress: emoji ack reply failed: ${(e as Error).message}`));
      },
      (action, result) => {
        const prefix = result.ok ? "✅" : "⚠️";
        void msg
          .reply({
            content: `${prefix} ${getRwf().WORKFLOW_ACTION_HELP[action].label}\n\n${result.text}`,
            allowedMentions: { repliedUser: false },
          })
          .catch((e) => deps.log.warn(`ingress: emoji result reply failed: ${(e as Error).message}`));
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
