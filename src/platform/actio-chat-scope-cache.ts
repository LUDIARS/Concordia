// @implements CC-ACTIO-CHAT-02
import { createHash } from "node:crypto";

/**
 * 中継の所属確認 (Discord channel → guild、Slack token → team) の結果を短時間覚える。
 * channel の所属 guild と token の所属 team は変わらないので、確認済みの値だけを TTL 付きで保持する。
 * 失敗した確認は覚えない (次の要求で取り直す)。
 */
export interface ChatScopeCache {
  get(platform: string, token: string, subject: string): string | undefined;
  set(platform: string, token: string, subject: string, scope: string): void;
}

export function createChatScopeCache(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): ChatScopeCache {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const maxEntries = opts.maxEntries ?? 500;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { scope: string; expiresAt: number }>();
  // token そのものを key に残さない。
  const key = (platform: string, token: string, subject: string) =>
    `${platform}:${createHash("sha256").update(token).digest("hex")}:${subject}`;
  return {
    get(platform, token, subject) {
      const k = key(platform, token, subject);
      const hit = entries.get(k);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) { entries.delete(k); return undefined; }
      return hit.scope;
    },
    set(platform, token, subject, scope) {
      const k = key(platform, token, subject);
      entries.delete(k);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(k, { scope, expiresAt: now() + ttlMs });
    },
  };
}
