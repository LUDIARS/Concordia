/**
 * 拠点で起動したセッションのスレッド台帳 (連合 Phase 4)。
 *
 * - 本社: スレッド → 拠点。拠点の egress 要求を「自分に渡したスレッド」宛てだけ通す。
 * - 拠点: スレッド → guild。spawn の再送を冪等にし、出力を返す宛先を引く。
 *
 * Cc 再起動をまたいで保持するため SettingsStore (schema_meta) に JSON で置く。
 * 件数は上限で切り、古いものから捨てる (長く使われたスレッドほど再起動されない)。
 *
 * @implements spec/feature/federation-link.md §本社からのセッション起動
 */
import type { SettingsStore } from "../admin/settings-store.js";

export const REMOTE_THREAD_LIMIT = 500;

export interface RemoteThreadEntry {
  guildId: string;
  /** 本社側: 渡した拠点。拠点側: null。 */
  siteId: string | null;
  at: number;
  /**
   * 本社側: そのスレッドで起動を依頼した人 (SPEC-FED-SITE-FORUM-PARITY)。 起動した側にだけメンションを付けるため、
   * 本社から起動したスレッドだけが持つ。 拠点で起動して映した投稿は持たない。
   */
  requesterId?: string;
}

export interface RemoteThreadRegistry {
  find(channelId: string): RemoteThreadEntry | null;
  /** 新規に記録できたら true (既にあれば false = 再送)。 */
  record(channelId: string, entry: RemoteThreadEntry): boolean;
  /** 記録を消す。起動に失敗したスレッドを、次の spawn で起動し直せるようにする。 */
  forget(channelId: string): void;
}

export function createRemoteThreadRegistry(store: Pick<SettingsStore, "get" | "set">, key: string): RemoteThreadRegistry {
  const read = (): Record<string, RemoteThreadEntry> => {
    try {
      const value = JSON.parse(store.get(key) ?? "{}") as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, RemoteThreadEntry> : {};
    } catch {
      return {};
    }
  };
  return {
    find(channelId) {
      const entry = read()[channelId];
      return entry && typeof entry.guildId === "string" ? entry : null;
    },
    record(channelId, entry) {
      const all = read();
      if (all[channelId]) return false;
      all[channelId] = entry;
      const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, REMOTE_THREAD_LIMIT);
      store.set(key, JSON.stringify(Object.fromEntries(kept)));
      return true;
    },
    forget(channelId) {
      const all = read();
      if (!all[channelId]) return;
      delete all[channelId];
      store.set(key, JSON.stringify(all));
    },
  };
}

/**
 * 本社: 拠点の発言に付けるメンション先 (SPEC-FED-SITE-FORUM-PARITY)。 拠点が求めたときだけ、 そのスレッドで
 * 本社から起動を依頼した人を返す。 拠点で起動して映した投稿には依頼者が無いので付けない (起動した側だけ)。
 */
export function requesterMentionFor(entry: RemoteThreadEntry | null, request: { mention_requester?: boolean }): string | undefined {
  return request.mention_requester && entry?.requesterId ? entry.requesterId : undefined;
}
