/**
 * Discord REST の速度制限 (429) で discord.js が待つときに、経路・待ち時間・全体制限かを記録する。
 *
 * discord.js は 429 を受けると黙って待ってから送り直す。待ちが長いと、呼び出し側からは
 * 「応答が返らない」としか見えない (2026-10-06、プライベート相談チャンネルの書き込み停止が 30 秒で
 * 打ち切られた件)。待ちの理由をログに残して切り分けられるようにする。
 *
 * @implements spec/feature/private-channels.md §5.1
 */
import { RESTEvents, type Client, type RateLimitData } from "discord.js";

export function describeRateLimit(info: Pick<RateLimitData, "route" | "method" | "timeToReset" | "limit" | "global" | "majorParameter">): string {
  return `discord rest rate limited method=${info.method} route=${info.route} major=${info.majorParameter}`
    + ` wait_ms=${info.timeToReset} limit=${info.limit} global=${info.global}`;
}

/** 物理 Client 1 つにつき 1 回だけ呼ぶ (gateway-pool.ts)。 */
export function watchRestRateLimits(client: Partial<Pick<Client, "rest">>, log: { warn(message: string): void }): void {
  // 単体テストの偽 Client は rest を持たない。 記録は補助なので、 無ければ付けない。
  client.rest?.on(RESTEvents.RateLimited, (info: RateLimitData) => log.warn(describeRateLimit(info)));
}
