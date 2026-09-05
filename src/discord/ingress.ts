import { ChannelType, type Message } from "discord.js";
import type { ChatChannel, ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordConfigRepo, DiscordMessageMapRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { isControlTrigger, postControlPanel } from "./control.js";
import { metaKindToChatChannel, type MetaChannelKind } from "./types.js";
import { recordInjectAck } from "./inject-ack.js";
import { injectSession } from "../platform/session-inject.js";
import { detectsEndSessionRequest, markEndSessionRequested } from "../shared/end-session-request.js";
import { classifyReactionIngress } from "../platform/reaction-ingress.js";
import { type WorkflowAction, type ReactionWorkflowInput, type WorkflowResultRelay } from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import { eventBus } from "../events.js";
import {
  buildDiscordImageInjectText,
  isDiscordImageAttachment,
  publicDiscordImageError,
  storeDiscordImages,
  type DiscordImageAttachment,
} from "./image-inbox.js";
import { appendDiscordEmbedContext, extractDiscordEmbedIngress } from "./embed-ingress.js";

const COMMAND_LIST_KEYWORD = "コマンドリスト";
const ACCEPTED_INJECT_REACTION = "✅";
const COMMAND_LIST_TEXT = [
  "使用可能コマンド一覧",
  "- session channel では通常メッセージ送信 = inject",
  "- /spawn: 新規セッション起動",
  "- /stat: 現在ステータス表示",
  "- /prs: PR キュー表示",
  "- /mmtask: Memoria タスク検索",
  "- /projects: プロジェクトコード一覧",
  "- /co-goal / /co-compaction / /co-relictor: セッション制御",
  "- /ch_name / /co-clean: Discord surface 管理",
  "- /confirm: develop 確認フロー",
  "- /ex-run / /ex-reboot: Excubitor 経由のサービス操作",
  "- /end-session: セッション終了",
  "- control / /control / コントロール: コントロールパネル表示",
].join("\n");

export interface IngressDeps {
  configRepo: DiscordConfigRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  sessionsRepo: SessionsRepo;
  concordiaUrl: string;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** Discord CDN image persistence seam. Tests can replace filesystem/network I/O. */
  storeImages?: typeof storeDiscordImages;
  /** standalone 絵文字 (🙏 等) を「直前メッセージへのリアクション」として扱うための解決系。 */
  chatRepo?: ChatRepo;
  /**
   * 人間がセッションのチャンネルへ投稿し、 それが inject として通った直後に呼ぶ。
   * 「人間が戻ってきた」の唯一の検知点で、 未回答質問の通知はここを起点にする
   * (spec/feature/approval-inbox.md §3.2)。 失敗しても inject の成否には影響させない。
   */
  onHumanReturn?: (sessionId: string, channelId: string, userId: string) => void;
  messageMap?: DiscordMessageMapRepo;
  /** リアクションワークフロー (reactions.ts と同一 runner)。 未注入なら絵文字単発はスキップ。 */
  workflow?: {
    handle(
      input: ReactionWorkflowInput,
      onAccept?: (action: WorkflowAction) => void,
      onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
    ): Promise<void>;
  };
  /**
   * 社員名簿の役職に基づく発火可否。 発火自体は誰でも可 (`reaction_workflow` = ヒラ社員)。
   * 指示の中身が要求する権限は runner 側 (`hasCapability`) で判定する。
   */
  isWorkflowUserAllowed?: (userId: string) => boolean;
  /** セッション終了発話の認可。未注入は deny (slash command と同じ fail-closed)。 */
  isSessionEndUserAllowed?: (userId: string) => boolean;
  /** Plan decisions and vibes acceptance unblock implementation/review, so require manager authority. */
  isPlanDecisionUserAllowed?: (userId: string) => boolean;
  /** LLM に届く発言をした Discord ユーザを社員名簿へ記録する (プロファイル名付き)。 */
  recordStaffAccess?: (input: { userId: string; displayName?: string; profileName?: string }) => void;
  /** ユーザ設定の 絵文字→アクション 上書き写像を live 解決する (単発絵文字の判定に使う)。 */
  resolveReactionMappings?: () => Record<string, WorkflowAction>;
  /**
   * 依頼窓口 (子会社の受付チャンネル / 本社内 desk のタスク依頼チャンネル)。 窓口チャンネルの
   * 新規メッセージはガードゲートに通し (process)、 ロック済みユーザは他チャンネルでも遮断する。
   * 子会社と desk はここでは区別しない — ゲートの通し方は同じ。
   * spec/feature/subsidiary-delegation.md §3.1 / §9。
   */
  intake?: {
    intakeChannelId: string | null;
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    isLocked: (userId: string) => boolean;
  };
  /** True only for a subsidiary guild; head-office desk intake remains false. */
  subsidiary?: boolean;
  /**
   * Session forum で「起動に要る情報が足りない」と聞き返したスレッドへの返信を、
   * 回答として取り込む (forum-spawn-intake.ts)。 取り込んだら true = 通常経路へ流さない。
   * 未配線なら従来どおり素通し。
   */
  handleForumSpawnIntakeReply?: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
    authorId: string;
    text: string;
  }) => Promise<boolean>;
  handlePlanReply?: (
    sessionId: string,
    text: string,
    authorId: string,
  ) => Promise<{ handled: boolean; reply?: string }>;
  /**
   * ドメインレビュー投稿への返信を回答として取り込む (設計書 §8.2 C-6)。
   * 取り込んだら handled = true で通常経路へは流さない — 投稿への返信は
   * セッションへの指示ではなく、人間のレビュー回答だから。
   */
  handleDomainReviewReply?: (input: {
    messageId: string;
    authorId: string;
    text: string;
    source: string;
  }) => Promise<{ handled: boolean; reply?: string }>;
  /** federation は Discord を import しないため、部署ルーティングだけを外から注入する。 */
  routeFederationIngress?: (input: {
    guildId: string; channelId: string; messageId: string; authorId: string; authorLabel: string; text: string; ts: number;
    appliedTagNames?: readonly string[];
  }) => boolean;
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
  const imageAttachments = [...msg.attachments.values()]
    .map((attachment): DiscordImageAttachment => ({
      contentType: attachment.contentType,
      name: attachment.name,
      size: attachment.size,
      url: attachment.url,
    }))
    .filter(isDiscordImageAttachment);
  const embedIngress = extractDiscordEmbedIngress(msg.embeds);
  imageAttachments.push(...embedIngress.images);
  const routeChannelId = resolveRouteChannelId(msg, deps.sessionChannelsRepo);
  const sessionRow = deps.sessionChannelsRepo.findByChannelId(routeChannelId);
  if (!text && (!sessionRow || (imageAttachments.length === 0 && !embedIngress.context))) {
    deps.log.info(`ingress: skip empty content channel=${msg.channelId}`);
    return;
  }

  // A reply to a domain-review post is review data, regardless of which Discord surface
  // contains the post or whether its text resembles a control command/comment. Resolve it
  // before federation, control, and intake paths can consume the message.
  const domainReviewRefId = msg.reference?.messageId;
  if (text && domainReviewRefId && deps.handleDomainReviewReply) {
    const outcome = await deps.handleDomainReviewReply({
      messageId: domainReviewRefId,
      authorId: msg.author.id,
      text,
      source: `discord:${msg.channelId}/${msg.id}`,
    }).catch((e) => {
      deps.log.warn(`ingress: domain-review reply failed message=${msg.id}: ${(e as Error).message}`);
      return { handled: false as const, reply: undefined };
    });
    if (outcome.handled) {
      deps.log.info(`ingress: domain-review reply recorded message=${msg.id} ref=${domainReviewRefId}`);
      if (outcome.reply) {
        await msg.reply({ content: outcome.reply, allowedMentions: { parse: [], repliedUser: false } })
          .catch(() => { /* ack は best-effort */ });
      }
      return;
    }
  }

  const authorLabel = msg.member?.nickname?.trim() || msg.author.username;
  if (text && deps.routeFederationIngress?.({
    guildId: msg.guildId,
    channelId: msg.channelId,
    messageId: msg.id,
    authorId: msg.author.id,
    authorLabel,
    text,
    ts: Math.floor(msg.createdTimestamp / 1000),
    appliedTagNames: resolveAppliedForumTagNames(msg),
  })) {
    deps.log.info(`ingress: federation routed guild=${msg.guildId} channel=${msg.channelId}`);
    return;
  }

  // ここから先はメッセージが Concordia (= LLM) に届く経路。 発言者を社員名簿へ記録し、
  // サーバーでのプロファイル名 (guild nickname) も併せて取る。 記録は「誰が触ったか」の
  // 台帳であって権限付与ではない — 役職の既定は ヒラ社員 (会話のみ)。
  deps.recordStaffAccess?.({
    userId: msg.author.id,
    displayName: msg.author.globalName?.trim() || msg.author.username,
    profileName: msg.member?.nickname?.trim() || msg.member?.displayName?.trim() || "",
  });

  if (isControlTrigger(text)) {
    if (deps.subsidiary) {
      deps.log.warn(`ingress: control panel rejected in subsidiary guild=${msg.guildId} user=${msg.author.id}`);
      await msg.reply({
        content: "このサーバではコントロールパネルを利用できません。依頼は受付チャンネルへメッセージでどうぞ。",
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => { /* best-effort */ });
      return;
    }
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

  deps.log.info(
    `ingress: routing channel=${msg.channelId} route_channel=${routeChannelId} ` +
    `type=${ChannelType[msg.channel.type] ?? msg.channel.type}`,
  );

  // 窓口: 依頼チャンネルの新規メッセージはガードゲートへ。 他チャンネルでもロック済みは遮断。
  if (deps.intake) {
    const intake = deps.intake;
    if (intake.intakeChannelId && routeChannelId === intake.intakeChannelId) {
      const userLabel = msg.member?.nickname?.trim() || msg.author.username;
      deps.log.info(`ingress: intake request channel=${msg.channelId} user=${msg.author.id}`);
      try {
        const result = await intake.process(msg.author.id, userLabel, text.slice(0, 8000));
        await msg.reply({ content: result.replyText, allowedMentions: { parse: [], repliedUser: false } });
      } catch (e) {
        deps.log.warn(`ingress: intake gate failed channel=${msg.channelId}: ${(e as Error).message}`);
        try { await msg.reply({ content: `⚠️ 内部エラーで処理できませんでした: ${(e as Error).message}`, allowedMentions: { parse: [], repliedUser: false } }); } catch {}
      }
      return;
    }
    if (intake.isLocked(msg.author.id)) {
      deps.log.info(`ingress: locked user=${msg.author.id} channel=${msg.channelId}; blocked`);
      try { await msg.reply({ content: "🔒 ロック中のため処理できません。", allowedMentions: { parse: [], repliedUser: false } }); } catch {}
      return;
    }
  }

  // Session forum の聞き返しへの返信は、 その場で spawn を再開する回答として取り込む。
  // セッション経路 (inject) にもチャット経路にも載せない。
  if (text && deps.handleForumSpawnIntakeReply) {
    const answered = await deps.handleForumSpawnIntakeReply({
      guildId: msg.guildId,
      channelId: msg.channelId,
      messageId: msg.id,
      authorId: msg.author.id,
      text: text.slice(0, 4000),
    }).catch((e) => {
      deps.log.warn(`ingress: forum-spawn intake reply failed channel=${msg.channelId}: ${(e as Error).message}`);
      return false;
    });
    if (answered) {
      deps.log.info(`ingress: forum-spawn intake answered channel=${msg.channelId} user=${msg.author.id}`);
      return;
    }
  }

  // 単発で投稿された絵文字 (🙏 / 🫶 等) は「直前メッセージへのリアクション」と同義に扱い、
  // inject / chat には載せずリアクションワークフローへ流す (返信なら参照先を対象に取る)。
  // 該当アクションの無い単発絵文字は却下し、 通常プロンプトとしても通さない。
  if (text && deps.workflow && sessionRow?.channel_kind === "thread") {
    const reactionRoute = classifyReactionIngress({
      text,
      classify: (emoji) => getRwf().classifyReactionWorkflow(emoji, deps.resolveReactionMappings?.()),
      isStandaloneEmoji: getRwf().isStandaloneEmoji,
    });
    if (reactionRoute.kind !== "prompt" && !deps.isWorkflowUserAllowed?.(msg.author.id)) {
      deps.log.info(`ingress: workflow emoji ignored unauthorized user=${msg.author.id}`);
      return;
    }
    if (reactionRoute.kind === "workflow") {
      if (await tryEmojiWorkflow(deps, msg, reactionRoute.emoji, routeChannelId)) return;
    } else if (reactionRoute.kind === "unsupported-emoji") {
      deps.log.info(`ingress: standalone emoji "${text.trim()}" has no workflow action → reject (prompt not forwarded)`);
      return;
    }
  }

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
    if (/^\s*\[OK\]\s*$/i.test(text)) {
      if (deps.isPlanDecisionUserAllowed?.(msg.author.id) !== true) {
        await msg.reply({
          content: "このユーザーには受け入れ権限がありません (管理職以上が必要)。",
          allowedMentions: { parse: [], repliedUser: false },
        }).catch(() => { /* denial reply is best-effort */ });
        return;
      }
      eventBus.emit({ type: "vibes.ok", session_id: sessionRow.session_id, source: `discord:${msg.author.id}:${msg.id}`, ts: Math.floor(Date.now() / 1000) });
      await msg.reply({ content: "Acceptance recorded. Submitting the existing working branch for review.", allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    const planReply = await deps.handlePlanReply?.(sessionRow.session_id, text, msg.author.id);
    if (planReply?.handled) {
      if (planReply.reply) await msg.reply({ content: planReply.reply, allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    const isEndSessionRequest = detectsEndSessionRequest(text);
    if (isEndSessionRequest && deps.isSessionEndUserAllowed?.(msg.author.id) !== true) {
      deps.log.warn(
        `ingress: spoken session-end rejected unauthorized session=${sessionRow.session_id}`,
      );
      try {
        await msg.reply({
          content: "このユーザーにはセッション終了権限がありません (管理職以上が必要)。",
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch { /* denial reply is best-effort */ }
      return;
    }
    try {
      // Session channel の通常発言は /inject と等価に扱う。
      // author_label を付けて Concordia に participants 登録 + 相手PFミラーの発言者明示に使う。
      const injectAuthor = msg.member?.nickname?.trim() || msg.author.username;
      const session = deps.sessionsRepo.findSession(sessionRow.session_id);
      const isCodexSession = session?.provider === "codex-cli";
      let injectText = appendDiscordEmbedContext(text, embedIngress.context);
      if (imageAttachments.length > 0) {
        try {
          const imagePaths = await (deps.storeImages ?? storeDiscordImages)({
            attachments: imageAttachments,
            messageId: msg.id,
            sessionId: sessionRow.session_id,
          });
          injectText = buildDiscordImageInjectText(injectText, imagePaths);
        } catch (error) {
          const reason = publicDiscordImageError(error);
          deps.log.warn(`ingress: image download failed session=${sessionRow.session_id} channel=${msg.channelId}: ${reason}`);
          await msg.reply({
            content: `画像をセッションへ渡せませんでした: ${reason}`,
            allowedMentions: { parse: [], repliedUser: false },
          }).catch(() => { /* failure reply is best-effort */ });
          return;
        }
      }
      const result = await injectSession({
        concordiaUrl: deps.concordiaUrl,
        sessionId: sessionRow.session_id,
        text: injectText,
        source: `discord:${msg.author.id}:${msg.channelId}:${msg.id}`,
        authorLabel: injectAuthor,
        enterFallbackSource: isCodexSession ? "discord-enter-fallback" : undefined,
      });
      if (!result.ok) {
        if (result.kind === "http") {
          deps.log.warn(`ingress: inject failed status=${result.status} session=${sessionRow.session_id} channel=${msg.channelId}`);
          try { await msg.reply({ content: `inject failed (${result.status})`, allowedMentions: { repliedUser: false } }); } catch {}
        } else {
          deps.log.warn(`ingress: inject network error session=${sessionRow.session_id} channel=${msg.channelId}: ${result.message}`);
          try { await msg.reply({ content: `network error: ${result.message}`, allowedMentions: { repliedUser: false } }); } catch {}
        }
        return;
      }
      // 「セッション終了」の発言は、指示の最後で /end-session 相当まで到達させる印を付ける
      // (終了はターンが静かになってから watcher が行う)。 セッション任せだとプロセスが
      // 残り続けることがあるため。
      if (isEndSessionRequest) {
        try {
          markEndSessionRequested(deps.sessionsRepo, sessionRow.session_id);
          deps.log.info(`ingress: session-end requested by speech session=${sessionRow.session_id}`);
        } catch (error) {
          deps.log.warn(`ingress: session-end mark failed session=${sessionRow.session_id}: ${(error as Error).message}`);
        }
      }
      let acceptedReactionApplied = false;
      if (isCodexSession) {
        acceptedReactionApplied = await reactToAcceptedInject(deps, msg, sessionRow.session_id);
      }
      // Codex は環境によって文字列 inject 後に Enter だけ追送しないと確定しない場合がある。
      // Discord session channel 経由の通常投稿では best-effort で改行 inject を追加する。
      // ✅ リアクションは「届いた」時点では付けない。 transcript が動いた
      // (= セッションが実際に読み込んで処理を始めた) タイミングで付けるため、
      // ここでは対象メッセージを保留登録するだけにする (bot の transcript.frame /
      // prompt ハンドラが takeInjectAck で取り出して付ける)。 Enter が送られず
      // 宙に浮いたケースでは transcript が動かないので ✅ が付かない = 見分けられる。
      if (!acceptedReactionApplied) {
        recordInjectAck(sessionRow.session_id, msg.channelId, msg.id);
      }
      deps.log.info(`ingress: inject ok session=${sessionRow.session_id} channel=${msg.channelId} user=${msg.author.id}`);
      try {
        deps.onHumanReturn?.(sessionRow.session_id, msg.channelId, msg.author.id);
      } catch (e) {
        deps.log.warn(`ingress: human-return notice failed session=${sessionRow.session_id}: ${(e as Error).message}`);
      }
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
  const author = authorLabel;
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

function resolveAppliedForumTagNames(msg: Message): string[] {
  if (msg.channel.type !== ChannelType.PublicThread || msg.channel.parent?.type !== ChannelType.GuildForum) return [];
  const byId = new Map(msg.channel.parent.availableTags.map((tag) => [tag.id, tag.name]));
  return msg.channel.appliedTags.flatMap((tagId) => {
    const name = byId.get(tagId);
    return name ? [name] : [];
  });
}

function resolveRouteChannelId(msg: Message, sessions: DiscordSessionChannelsRepo): string {
  if (
    msg.channel.type === ChannelType.PublicThread ||
    msg.channel.type === ChannelType.PrivateThread ||
    msg.channel.type === ChannelType.AnnouncementThread
  ) {
    // Forum mode stores the thread id itself in discord_session_channels. Legacy
    // text-channel child threads still route through their parent channel.
    if (sessions.findByChannelId(msg.channelId)?.channel_kind === "thread") return msg.channelId;
    return msg.channel.parentId ?? msg.channelId;
  }
  return msg.channelId;
}

async function reactToAcceptedInject(deps: IngressDeps, msg: Message, sessionId: string): Promise<boolean> {
  try {
    await msg.react(ACCEPTED_INJECT_REACTION);
    return true;
  } catch (e) {
    deps.log.warn(`ingress: accepted react failed session=${sessionId} channel=${msg.channelId}: ${(e as Error).message}`);
    return false;
  }
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
  const sessionRow = deps.sessionChannelsRepo.findByChannelId(routeChannelId);
  if (sessionRow?.channel_kind !== "thread") return false;

  // chat_messages は直前投稿の本文を補うだけで、発火条件にはしない。transcript relay と
  // chat.posted は別経路なので、DB に直近行が無いセッションでも単独絵文字は有効であるべき。
  const target = resolveEmojiTarget(deps, msg, sessionRow.session_id);
  const session = deps.sessionsRepo.findSession(sessionRow.session_id);
  deps.log.info(
    `ingress: emoji "${emoji}" → reaction-workflow ` +
    `session=${sessionRow.session_id} target=${target?.id ?? "session-context"} channel=${msg.channelId}`,
  );
  void deps.workflow
    .handle(
      {
        dedupeKey: target ? `chat:${target.id}` : `discord:${msg.id}`,
        platform: "discord",
        sourceMessageId: msg.id,
        emoji,
        userId: msg.author.id,
        messageText: target?.text ?? "",
        authorLabel: target?.author_label ?? "unknown",
        repoPath: session?.repo_path ?? null,
        sessionActive: session?.status === "active",
        sessionId: sessionRow.session_id,
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

/** 単発絵文字の対象メッセージ: 返信先 → session の直近の順で補助的に解決する。 */
function resolveEmojiTarget(deps: IngressDeps, msg: Message, sessionId: string) {
  // 1. 返信メッセージなら参照先を対象に取る (リアクションと同義の最も明示的な指定)。
  const refId = msg.reference?.messageId;
  if (refId && deps.messageMap && deps.chatRepo) {
    const id = deps.messageMap.findChatId(refId);
    if (id != null) return deps.chatRepo.findById(id);
  }
  return deps.chatRepo?.latestForSession(sessionId) ?? null;
}

export function resolveMetaKind(configRepo: DiscordConfigRepo, channelId: string): MetaChannelKind | null {
  const map = configRepo.all();
  for (const k of ["chitchat", "consultation", "houkoku", "boyaki", "system", "genius"] as const) {
    if (map[`${k}_channel_id`] === channelId) return k;
  }
  return null;
}
