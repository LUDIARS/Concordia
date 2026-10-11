/**
 * 本社側: 拠点で起動したセッションを Session フォーラムへ映す投稿を立てる (SPEC-FED-SITE-SESSION-MIRROR)。
 *
 * 2026-10-11 neco「MELPOT側のフォーラムでspawnしていた。本社側でも投稿できるようにしてほしい」。
 * 立てた投稿はスレッド台帳 (federation.hq.remote_threads) に拠点として記録する。 これで拠点の発言 (egress) が
 * 通り、投稿への人の返信は既存の ingress 転送で拠点へ届く。 Discord 実体は bot.ts が opener として注入する
 * (federation 層は discord/ を import しない)。
 *
 * @implements spec/feature/federation-link.md §拠点で起動したセッションを本社へ映す
 */
import { markSiteTitle } from "./forum-site-routing.js";
import type { FederationMirrorOpenRequestFrame } from "./protocol.js";
import type { RemoteThreadRegistry } from "./remote-thread-registry.js";
import type { SessionMirrorStore } from "./session-mirror-store.js";

/** Session フォーラムに投稿を立てる Discord ポート。 */
export type MirrorPostOpener = (input: { title: string; text: string }) => Promise<{ guildId: string; channelId: string }>;

export interface HqSessionMirrorDeps {
  threads: RemoteThreadRegistry;
  mirrors: SessionMirrorStore;
  /** 有効な拠点の表示名。 失効・未登録なら null。 */
  activeSiteName(siteId: string): string | null;
  opener(): MirrorPostOpener | null;
  now?: () => number;
  log: { info(message: string): void; warn(message: string): void };
}

export type MirrorOpenOutcome = { ok: true; guildId: string; channelId: string } | { ok: false; error: string };

export function createHqSessionMirror(deps: HqSessionMirrorDeps) {
  const now = deps.now ?? Date.now;
  const inFlight = new Map<string, Promise<MirrorOpenOutcome>>();
  return {
    async open(siteId: string, request: Pick<FederationMirrorOpenRequestFrame, "session_id" | "title" | "text">): Promise<MirrorOpenOutcome> {
      const siteName = deps.activeSiteName(siteId);
      if (!siteName) return { ok: false, error: `unknown or revoked site: ${siteId}` };
      const key = `${siteId}:${request.session_id}`;
      // 再送 (応答の取りこぼし) では同じ投稿を返す。
      const existing = deps.mirrors.find(key);
      if (existing) {
        // 投稿の保存後、スレッド台帳の保存だけが失敗した場合も再送で修復する。
        deps.threads.record(existing.channelId, { guildId: existing.guildId, siteId, at: now() });
        return { ok: true, guildId: existing.guildId, channelId: existing.channelId };
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const operation = (async (): Promise<MirrorOpenOutcome> => {
        const opener = deps.opener();
        if (!opener) return { ok: false, error: "HQ Session forum is unavailable" };
        let post: { guildId: string; channelId: string };
        try {
          post = await opener({ title: markSiteTitle(request.title, siteName), text: request.text });
        } catch (error) {
          deps.log.warn(`federation session mirror post failed site=${siteId} session=${request.session_id}: ${(error as Error).message}`);
          return { ok: false, error: "HQ could not open a Session forum post" };
        }
        const at = now();
        // 投稿との対応を先に保存し、後段のスレッド台帳失敗は再送時に修復できるようにする。
        deps.mirrors.record(key, { guildId: post.guildId, channelId: post.channelId, at });
        deps.threads.record(post.channelId, { guildId: post.guildId, siteId, at });
        deps.log.info(`federation session mirrored site=${siteId} session=${request.session_id} channel=${post.channelId}`);
        return { ok: true, ...post };
      })();
      inFlight.set(key, operation);
      try {
        return await operation;
      } finally {
        if (inFlight.get(key) === operation) inFlight.delete(key);
      }
    },
  };
}
