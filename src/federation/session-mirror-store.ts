/**
 * 拠点のセッションを本社の Session フォーラムへ映した投稿の台帳 (SPEC-FED-SITE-SESSION-MIRROR)。
 *
 * - 本社: `<site_id>:<session_id>` → 投稿。 拠点の再送で同じセッションの投稿を 2 つ立てない。
 * - 拠点: `<session_id>` → 投稿。 発言を返す宛先と、本社からの返信を注入するセッションを引く。
 *
 * Cc 再起動をまたいで保持するため SettingsStore (schema_meta) に JSON で置き、古いものから捨てる。
 */
import type { SettingsStore } from "../admin/settings-store.js";

export const SESSION_MIRROR_LIMIT = 500;
export const HQ_SESSION_MIRRORS_KEY = "federation.hq.session_mirrors";
export const SITE_SESSION_MIRRORS_KEY = "federation.site.session_mirrors";

export interface SessionMirrorEntry {
  guildId: string;
  channelId: string;
  at: number;
}

export interface SessionMirrorStore {
  find(key: string): SessionMirrorEntry | null;
  /** 投稿 (channel) から台帳の key を引く。 */
  keyOfChannel(channelId: string): string | null;
  record(key: string, entry: SessionMirrorEntry): void;
}

export function createSessionMirrorStore(store: Pick<SettingsStore, "get" | "set">, settingsKey: string): SessionMirrorStore {
  const valid = (entry: SessionMirrorEntry | undefined): entry is SessionMirrorEntry =>
    Boolean(entry
      && typeof entry.guildId === "string"
      && entry.guildId.length > 0
      && typeof entry.channelId === "string"
      && entry.channelId.length > 0
      && typeof entry.at === "number"
      && Number.isFinite(entry.at));
  const read = (): Record<string, SessionMirrorEntry> => {
    try {
      const value = JSON.parse(store.get(settingsKey) ?? "{}") as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return Object.create(null) as Record<string, SessionMirrorEntry>;
      const entries: Record<string, SessionMirrorEntry> = Object.create(null) as Record<string, SessionMirrorEntry>;
      for (const [key, entry] of Object.entries(value)) {
        if (valid(entry as SessionMirrorEntry | undefined)) entries[key] = entry as SessionMirrorEntry;
      }
      return entries;
    } catch {
      return Object.create(null) as Record<string, SessionMirrorEntry>;
    }
  };
  return {
    find(key) {
      const entry = read()[key];
      return valid(entry) ? entry : null;
    },
    keyOfChannel(channelId) {
      const found = Object.entries(read()).find(([, entry]) => valid(entry) && entry.channelId === channelId);
      return found ? found[0] : null;
    },
    record(key, entry) {
      if (!key || !valid(entry)) throw new Error("invalid session mirror entry");
      const all = read();
      all[key] = entry;
      const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, SESSION_MIRROR_LIMIT);
      store.set(settingsKey, JSON.stringify(Object.fromEntries(kept)));
    },
  };
}
