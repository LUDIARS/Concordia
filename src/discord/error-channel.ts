import type { TextChannel } from "discord.js";
import { createChildLogger } from "../shared/logger.js";

// このロガーは bot.ts の forwarding 版 log とは別物 (reportError へ転送しない).
// errors チャンネルへの投稿自体が失敗したときにここへ吐く → 再帰ループを断つ.
const log = createChildLogger("discord-error");

export interface ErrorRecord {
  source: string;
  message: string;
  detail?: Record<string, unknown>;
  ts: number;
}

/**
 * error.reported を errors チャンネルへ転記する poster.
 *  - バッファ + 一定間隔 flush でレート制御 (Discord の投稿頻度を抑える)
 *  - 直近に同一 (source|message) が来たら回数だけ畳む (スパム抑制)
 *  - 自身の送信失敗は専用 logger で握り潰す (reportError に戻さない = ループ防止)
 */
export class ErrorChannelPoster {
  private buffer: Array<{ rec: ErrorRecord; count: number }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushMs: number;

  constructor(
    private readonly channel: TextChannel,
    opts: { flushMs?: number } = {},
  ) {
    this.flushMs = Math.max(1000, opts.flushMs ?? 3000);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  enqueue(rec: ErrorRecord): void {
    const key = `${rec.source}|${rec.message}`;
    const existing = this.buffer.find((b) => `${b.rec.source}|${b.rec.message}` === key);
    if (existing) {
      existing.count += 1;
      return;
    }
    // バッファ暴走防止: 上限を超えたら古いものから捨てる.
    if (this.buffer.length >= 50) this.buffer.shift();
    this.buffer.push({ rec, count: 1 });
  }

  private format(item: { rec: ErrorRecord; count: number }): string {
    const { source, message, detail, ts } = item.rec;
    const dup = item.count > 1 ? ` ×${item.count}` : "";
    const det = detail && Object.keys(detail).length > 0
      ? " " + JSON.stringify(detail).slice(0, 300)
      : "";
    return `🔴 <t:${ts}:T> \`[${source}]\`${dup} ${message}${det}`.slice(0, 1800);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const items = this.buffer;
    this.buffer = [];
    // 1 メッセージ ~1900 字に詰めて送る (複数行をまとめる).
    let chunk = "";
    const sendChunk = async (text: string) => {
      if (!text) return;
      try {
        await this.channel.send({ content: text, allowedMentions: { parse: [] } });
      } catch (e) {
        log.warn(`errors channel send failed: ${(e as Error).message}`);
      }
    };
    for (const item of items) {
      const line = this.format(item);
      if (chunk.length + line.length + 1 > 1900) {
        await sendChunk(chunk);
        chunk = "";
      }
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
    await sendChunk(chunk);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
