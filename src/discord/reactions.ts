// Discord MessageReactionAdd / Remove → chat_message_reactions 記録 + リアクションWF発火.
//
// 設計 (2026-06-10 改訂):
//   - リアクションWF は「どのメッセージに付いても発火」する。 メッセージ本文は
//     プラットフォーム API (reaction.message) から直接取得し、 discord_message_map /
//     chat_messages には依存しない。
//   - session/リポ文脈は channelId → discord_session_channels → session で逆引きする
//     (メッセージが内部 chat_messages に無くても文脈が取れる)。
//   - chat_message_reactions への fine/bad 記録は従来通り、 Concordia 投稿に紐づく
//     (= message-map に在る) ものだけ記録する。
//
// 自分の bot が付けたリアクション (起動時の guidance 用等) は無視する.

import type {
  MessageReaction,
  PartialMessageReaction,
  Message,
  PartialMessage,
  User,
  PartialUser,
} from "discord.js";
import {
  classifyEmoji,
  type ChatMessageReactionsRepo,
  type DiscordMessageMapRepo,
  type DiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import {
  type ReactionWorkflowInput,
  type WorkflowResultRelay,
  type WorkflowAction,
} from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";

/** 📌 で transcript relay を /clear なしで再束縛する built-in アクションのトリガー絵文字。 */
const REPIN_EMOJI = "📌";

/** session の作業ディレクトリ / 状態を引く最小インタフェース (SessionsRepo の部分)。 */
export interface SessionLookup {
  findSession(sessionId: string): { repo_path: string; status: string } | null;
}

export interface ReactionsDeps {
  reactionsRepo: ChatMessageReactionsRepo;
  messageMap: DiscordMessageMapRepo;
  log: { info: (m: string) => void };
  /**
   * リアクションを「指示」として処理に変換するワークフロー (任意)。
   * message-map に依存せず fire-and-forget で呼ぶ。
   */
  workflow?: {
    handle(
      input: ReactionWorkflowInput,
      onAccept?: (action: WorkflowAction) => void,
      onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
    ): Promise<void>;
  };
  /** Workflow execution is deny-by-default and requires an exact platform user ID match. */
  isWorkflowUserAllowed?: (userId: string) => boolean;
  /** channelId → session 解決 (WF 文脈)。 未注入なら repoPath/sessionId は null。 */
  sessionChannels?: DiscordSessionChannelsRepo;
  sessions?: SessionLookup;
  /**
   * 📌 re-pin: セッションチャンネルで pushpin リアクション → その session の Lictor へ
   * `POST /v1/repin` を投げ、 transcript relay を /clear なしで生 transcript へ束縛し直す。
   * built-in 操作 (RWF プラグインに依らない)。 未注入なら 📌 は no-op。
   */
  repin?: (sessionId: string) => Promise<{ ok: boolean; path?: string | null; error?: string }>;
}

export async function handleReactionAdd(
  deps: ReactionsDeps,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;

  // Partial の場合は fetch (cache 外の古いメッセージ)
  let r = reaction;
  if (r.partial) {
    try { r = await r.fetch(); } catch { return; }
  }
  const emoji = r.emoji.name ?? r.emoji.toString();
  if (!emoji) return;

  // メッセージ本文をプラットフォームから取得 (partial なら fetch)。 取れなくても
  // 残作業系 WF は本文不要なので続行する。
  let message: Message<boolean> | PartialMessage = r.message;
  if (message.partial) {
    try { message = await message.fetch(); } catch { /* 本文無しで続行 */ }
  }
  const discordMessageId = message.id;
  const messageText = message.content ?? "";
  const authorLabel = message.author?.username ?? "unknown";
  const channelId = message.channelId;

  // channelId → session 解決 (chat_messages に無くても文脈が取れる)。
  let repoPath: string | null = null;
  let sessionActive = false;
  let sessionId: string | null = null;
  if (channelId && deps.sessionChannels && deps.sessions) {
    const sc = deps.sessionChannels.findByChannelId(channelId);
    if (sc) {
      sessionId = sc.session_id;
      const s = deps.sessions.findSession(sc.session_id);
      if (s) {
        repoPath = s.repo_path;
        sessionActive = s.status === "active";
      }
    }
  }

  // 📌 re-pin (built-in): セッションチャンネルで pushpin → その Lictor の transcript relay を
  // /clear なしで再束縛する。 stall (Concordia 再起動で中継が止まった等) からの手動復帰口。
  // session 未解決 / 非 active のときは無視 (壊れた相手に投げない)。
  if (deps.repin && emoji === REPIN_EMOJI && sessionId && sessionActive) {
    const sid = sessionId;
    void deps.repin(sid)
      .then((res) => {
        const text = res.ok
          ? `📌 relay を再束縛しました${res.path ? ` → \`${res.path.split(/[\\/]/).pop()}\`` : ""}`
          : `📌 re-pin 失敗: ${res.error ?? "新しい transcript が見つかりません"}`;
        return message
          .reply({ content: text, allowedMentions: { repliedUser: false } })
          .catch((e) => deps.log.info(`reactions: repin ack failed: ${(e as Error).message}`));
      })
      .catch((e) => deps.log.info(`reactions: repin failed for ${sid}: ${(e as Error).message}`));
  }

  // ワークフロー: message-map に依存せず、 どのメッセージでも発火させる (fire-and-forget)。
  // 発火が確定したら、 トリガー元メッセージへ「受付」リプライを返して発生を可視化する。
  if (deps.workflow && deps.isWorkflowUserAllowed?.(user.id)) {
    void deps.workflow
      .handle(
        { dedupeKey: discordMessageId, emoji, userId: user.id, messageText, authorLabel, repoPath, sessionActive, sessionId },
        (action) => {
          void message
            .reply({ content: getRwf().reactionAckText(action, emoji), allowedMentions: { repliedUser: false } })
            .catch((e) => deps.log.info(`reactions: ack reply failed: ${(e as Error).message}`));
        },
        (action, result) => {
          const prefix = result.ok ? "✅" : "⚠️";
          void message
            .reply({
              content: `${prefix} ${getRwf().WORKFLOW_ACTION_HELP[action].label}\n\n${result.text}`,
              allowedMentions: { repliedUser: false },
            })
            .catch((e) => deps.log.info(`reactions: result reply failed: ${(e as Error).message}`));
        },
      )
      .catch((e) => deps.log.info(`reactions: workflow failed: ${(e as Error).message}`));
  } else if (deps.workflow) {
    deps.log.info(`reactions: workflow ignored unauthorized user=${user.id}`);
  }

  // chat_message_reactions 記録: Concordia 投稿 (= message-map に在る) ものだけ。
  const chatId = deps.messageMap.findChatId(discordMessageId);
  if (chatId != null) {
    const kind = classifyEmoji(emoji);
    deps.reactionsRepo.add({ message_id: chatId, discord_user_id: user.id, kind });
    deps.log.info(`reactions: ${user.id} reacted ${kind} on chat_messages.id=${chatId}`);
  }
}

export async function handleReactionRemove(
  deps: ReactionsDeps,
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;
  let r = reaction;
  if (r.partial) {
    try { r = await r.fetch(); } catch { return; }
  }
  const emoji = r.emoji.name ?? r.emoji.toString();
  if (!emoji) return;

  const chatId = deps.messageMap.findChatId(r.message.id);
  if (chatId == null) return;
  deps.reactionsRepo.remove({
    message_id: chatId,
    discord_user_id: user.id,
    kind: classifyEmoji(emoji),
  });
}
