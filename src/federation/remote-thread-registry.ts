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
}

export interface RemoteThreadRegistry {
  find(channelId: string): RemoteThreadEntry | null;
  /** 新規に記録できたら true (既にあれば false = 再送)。 */
  record(channelId: string, entry: RemoteThreadEntry): boolean;
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
  };
}
