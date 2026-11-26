/**
 * 接続中のセッションの台帳 (契約 v1 §1 失効即切断 / §2 同時接続 2)。
 *
 * - 1 トークンの同時接続は 2 本まで。
 * - 失効・期限切れを拾ったら、 そのトークンの接続を 4401 で切る。
 * - GLab から抜けた人の接続は 4403 で切る。
 * - event (discord.message / calliope.updated) を購読者へ配る。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-SESSION)
 */

import { HUB_CLOSE_CODES } from "../domain/protocol.js";
import { HUB_LIMITS, SlidingWindowLimiter } from "../domain/rate-limit.js";
import type { MessageSummary } from "./ports.js";

/** 台帳から見たセッション。 実体は hub-session.ts。 */
export interface RegisteredSession {
  readonly tokenId: string;
  readonly discordUserId: string;
  isSubscribed(channelId: string): boolean;
  pushEvent(event: string, data: unknown): void;
  terminate(code: number, reason: string): void;
}

export class ConnectionRegistry {
  private readonly sessions = new Set<RegisteredSession>();
  /** 投稿は 1 ユーザー毎分 10 件 (接続をまたいで数える)。 */
  readonly posts = new SlidingWindowLimiter(HUB_LIMITS.postsPerUserPerMinute);

  /** 同時接続の上限内なら登録して true。 */
  add(session: RegisteredSession): boolean {
    const sameToken = [...this.sessions].filter((entry) => entry.tokenId === session.tokenId).length;
    if (sameToken >= HUB_LIMITS.concurrentConnectionsPerToken) return false;
    this.sessions.add(session);
    return true;
  }

  remove(session: RegisteredSession): void {
    this.sessions.delete(session);
  }

  size(): number {
    return this.sessions.size;
  }

  /** 失効したトークンの接続を切る。 切った本数を返す。 */
  closeTokens(tokenIds: readonly string[], reason = "token revoked"): number {
    const wanted = new Set(tokenIds);
    let closed = 0;
    for (const session of [...this.sessions]) {
      if (!wanted.has(session.tokenId)) continue;
      session.terminate(HUB_CLOSE_CODES.unauthorized, reason);
      this.sessions.delete(session);
      closed += 1;
    }
    return closed;
  }

  /** GLab から抜けた人の接続を 4403 で切る。 */
  closeUser(discordUserId: string): number {
    let closed = 0;
    for (const session of [...this.sessions]) {
      if (session.discordUserId !== discordUserId) continue;
      session.terminate(HUB_CLOSE_CODES.forbidden, "left GLab guild");
      this.sessions.delete(session);
      closed += 1;
    }
    return closed;
  }

  broadcast(event: string, data: unknown): void {
    for (const session of this.sessions) session.pushEvent(event, data);
  }

  /**
   * 購読者へ Discord のメッセージを配る。 配る直前に本人がまだ読めるかを確かめる
   * (購読後に権限が外れた人へ流さない)。
   */
  async deliverDiscordMessage(
    channelId: string,
    message: MessageSummary,
    canRead: (discordUserId: string, channelId: string) => Promise<boolean>,
  ): Promise<void> {
    for (const session of [...this.sessions]) {
      if (!session.isSubscribed(channelId)) continue;
      if (!(await canRead(session.discordUserId, channelId).catch(() => false))) continue;
      session.pushEvent("discord.message", { channelId, ...message });
    }
  }

  closeAll(code: number, reason: string): void {
    for (const session of [...this.sessions]) session.terminate(code, reason);
    this.sessions.clear();
  }
}
