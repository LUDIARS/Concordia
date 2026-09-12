/**
 * Review-thread comments never start sessions. Explicitly started test sessions
 * can still receive replies in their existing thread.
 * @implements spec/feature/revisor-test-forum-sync.md — テストセッションとスレッド投稿
 */
import { ChannelType, type Message } from "discord.js";
import type { DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";

export interface TestForumMessageDeps {
  testForumId: string;
  surfaces: DiscordTestSurfacesRepo;
  concordiaUrl: string;
  workspaceRoots?: readonly string[];
  /** テスト開始ボタンと同じ権限 (session_spawn, 管理職以上)。 未注入は deny。 */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /** 生きているセッションか (sessions repo の status で判定)。 */
  isSessionAlive: (sessionId: string) => boolean;
  /** 生きているセッションへユーザ投稿を指示として届ける。 */
  injectToSession: (sessionId: string, text: string, source: string) => void;
  log: { info(message: string): void; warn(message: string): void };
}

/**
 * Test Forum スレッドへの人間の投稿なら処理して true。 それ以外 (Bot / 対象外
 * チャンネル / 閉じた surface) は false を返して通常の ingress に委ねる。
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
  if (!text) return true;

  // Reports and ordinary discussion are the primary UX. Only the explicit test
  // control may start a session; an already-started session still receives replies.
  if (!surface.session_id || !deps.isSessionAlive(surface.session_id)) return true;

  const source = `discord:${msg.author.id}:${msg.channelId}:${msg.id}`;
  deps.injectToSession(surface.session_id, text, source);
  await msg.react("📨").catch(() => { /* Reaction is best-effort; the reply was already injected. */ });
  return true;
}
