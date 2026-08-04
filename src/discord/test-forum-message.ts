/**
 * Test Forum スレッド内のユーザ投稿の検知。 投稿を指示として、 テストセッションを
 * 起動する (既に生きていれば inject で引き継ぐ)。
 * @implements spec/feature/revisor-test-forum-sync.md — テストセッションとスレッド投稿
 */
import { ChannelType, type Message } from "discord.js";
import type { DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import { requestTestSpawn } from "./test-forum-actions.js";

export interface TestForumMessageDeps {
  testForumId: string;
  surfaces: DiscordTestSurfacesRepo;
  concordiaUrl: string;
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

  // 既にテストセッションが生きていれば、 新しく立てず指示として届ける。
  if (surface.session_id && deps.isSessionAlive(surface.session_id)) {
    const source = `discord:${msg.author.id}:${msg.channelId}:${msg.id}`;
    deps.injectToSession(surface.session_id, text, source);
    await msg.react("📨").catch(() => { /* best-effort */ });
    return true;
  }

  // 投稿からの起動はテスト開始ボタンと同じ特権 spawn なので、 同じ権限で守る。
  if (deps.isLaunchUserAllowed?.(msg.author.id) !== true) {
    deps.log.info(
      `test-forum message spawn denied user=${msg.author.id} thread=${channel.id}`,
    );
    await msg.react("🚫").catch(() => { /* best-effort */ });
    return true;
  }
  if (surface.run_state !== "candidate") {
    // testing でセッションが死んでいる場合など。 状態機械を乱さず案内だけ返す。
    await msg.react("⚠️").catch(() => { /* best-effort */ });
    return true;
  }
  const result = await requestTestSpawn(surface, deps, text);
  if (!result.ok) {
    deps.log.warn(
      `test-forum message spawn failed ${surface.repo_origin}#${surface.pr_number}: ${result.error}`,
    );
    await msg.react("⚠️").catch(() => { /* best-effort */ });
    return true;
  }
  deps.log.info(
    `test-forum message spawned ${surface.repo_origin}#${surface.pr_number} pid=${result.pid ?? "n/a"}`,
  );
  await msg.react("🧪").catch(() => { /* best-effort */ });
  return true;
}
