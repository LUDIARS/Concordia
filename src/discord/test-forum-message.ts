/**
 * Review-thread comments never start sessions. Explicitly started test sessions
 * can still receive replies in their existing thread.
 * @implements spec/feature/revisor-test-forum-sync.md — テストセッションとスレッド投稿
 */
import { ChannelType, type Message } from "discord.js";
import type { DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import { buildDiscordFileInjectText, publicDiscordFileError, storeDiscordFiles } from "./attachment-inbox.js";
import { buildDiscordImageInjectText, publicDiscordImageError, storeDiscordImages } from "./image-inbox.js";
import { splitMessageAttachments } from "./message-attachments.js";

export interface TestForumMessageDeps {
  testForumId: string;
  surfaces: DiscordTestSurfacesRepo;
  concordiaUrl: string;
  workspaceRoots?: readonly string[];
  /** テスト開始ボタンと同じ権限 (session_spawn、 ヒラ社員から可)。 未注入は deny。 */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /** 生きているセッションか (sessions repo の status で判定)。 */
  isSessionAlive: (sessionId: string) => boolean;
  /** 生きているセッションへユーザ投稿を指示として届ける。 */
  injectToSession: (sessionId: string, text: string, source: string) => void;
  /** テスト用の差し替え口。 未注入なら ingress と同じ保存処理を使う。 */
  storeImages?: typeof storeDiscordImages;
  storeFiles?: typeof storeDiscordFiles;
  log: { info(message: string): void; warn(message: string): void };
}

/**
 * Test Forum スレッドへの人間の投稿なら処理して true。 それ以外 (Bot / 対象外
 * チャンネル / 閉じた surface) は false を返して通常の ingress に委ねる。
 *
 * 画像・添付だけの投稿もセッションへ届ける (2026-11-26 neco 指示「画像だけの投稿を無視しないようにして」)。
 * テスターのスクショが文字なしで貼られることが多く、 以前は黙って捨てていた。
 */
export async function handleTestForumMessage(
  msg: Message,
  deps: TestForumMessageDeps,
): Promise<boolean> {
  if (!deps.testForumId) return false;
  if (msg.author.bot || msg.webhookId) return false;
  const channel = msg.channel;
  if (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread) {
    return false;
  }
  if (channel.parentId !== deps.testForumId) return false;
  const surface = deps.surfaces.listOpen().find((row) => row.thread_id === channel.id);
  if (!surface) return false;
  const text = msg.content.trim();
  const { images, files } = splitMessageAttachments(msg.attachments?.values() ?? []);
  if (!text && images.length === 0 && files.length === 0) return true;

  // Reports and ordinary discussion are the primary UX. Only the explicit test
  // control may start a session; an already-started session still receives replies.
  if (!surface.session_id || !deps.isSessionAlive(surface.session_id)) return true;

  const sessionId = surface.session_id;
  let injectText = text;
  try {
    if (images.length > 0) {
      const paths = await (deps.storeImages ?? storeDiscordImages)({ attachments: images, messageId: msg.id, sessionId });
      injectText = buildDiscordImageInjectText(injectText, paths);
    }
  } catch (error) {
    await replyAttachmentFailure(msg, deps, `画像をセッションへ渡せませんでした: ${publicDiscordImageError(error)}`);
    return true;
  }
  try {
    if (files.length > 0) {
      const stored = await (deps.storeFiles ?? storeDiscordFiles)({ attachments: files, messageId: msg.id, sessionId });
      injectText = buildDiscordFileInjectText(injectText, stored);
    }
  } catch (error) {
    await replyAttachmentFailure(msg, deps, `添付ファイルをセッションへ渡せませんでした: ${publicDiscordFileError(error)}`);
    return true;
  }

  const source = `discord:${msg.author.id}:${msg.channelId}:${msg.id}`;
  deps.injectToSession(sessionId, injectText, source);
  await msg.react("📨").catch(() => { /* Reaction is best-effort; the reply was already injected. */ });
  return true;
}

async function replyAttachmentFailure(msg: Message, deps: TestForumMessageDeps, content: string): Promise<void> {
  deps.log.warn(`test-forum: attachment relay failed channel=${msg.channelId} message=${msg.id}`);
  await msg.reply({ content, allowedMentions: { parse: [], repliedUser: false } })
    .catch(() => { /* failure reply is best-effort */ });
}
