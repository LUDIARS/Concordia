/**
 * 本社が拠点から受け取ったその日の作業記録の台帳 (SPEC-FED-SITE-ACTIVITY)。
 *
 * 同じ拠点・日付は後着で上書きする (拠点は定期的に送り直す)。 Cc 再起動をまたいで保持するため
 * SettingsStore (schema_meta) に JSON で置き、 受信の古いものから捨てる。
 */
import type { SettingsStore } from "../admin/settings-store.js";
import type { SiteActivityEntry, SiteDayActivity } from "../daily/site-activity.js";

export const HQ_SITE_ACTIVITY_KEY = "federation.hq.site_activity";
/** 拠点数 × 保持日数の上限。 日報は今日・昨日しか読まないので 2 週間分あれば足りる。 */
export const SITE_ACTIVITY_LIMIT = 300;

export interface SiteActivityStore {
  record(siteId: string, siteName: string, report: SiteDayActivity, receivedAt?: number): void;
  listForDate(dateIso: string): SiteActivityEntry[];
}

function isEntry(value: unknown): value is SiteActivityEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SiteActivityEntry>;
  return typeof entry.site_id === "string"
    && typeof entry.site_name === "string"
    && typeof entry.received_at === "number"
    && Boolean(entry.report)
    && typeof entry.report?.date_iso === "string"
    && Array.isArray(entry.report?.sessions);
}

export function createSiteActivityStore(store: Pick<SettingsStore, "get" | "set">, settingsKey = HQ_SITE_ACTIVITY_KEY): SiteActivityStore {
  const read = (): Record<string, SiteActivityEntry> => {
    const entries = Object.create(null) as Record<string, SiteActivityEntry>;
    try {
      const value = JSON.parse(store.get(settingsKey) ?? "{}") as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return entries;
      for (const [key, entry] of Object.entries(value)) {
        if (isEntry(entry)) entries[key] = entry;
      }
    } catch {
      // 壊れた値は空として扱い、 次の記録で書き直す。
    }
    return entries;
  };
  return {
    record(siteId, siteName, report, receivedAt = Math.floor(Date.now() / 1000)) {
      if (!siteId) throw new Error("site activity requires a site id");
      const all = read();
      all[`${siteId}:${report.date_iso}`] = { site_id: siteId, site_name: siteName || siteId, received_at: receivedAt, report };
      const kept = Object.entries(all).sort((a, b) => b[1].received_at - a[1].received_at).slice(0, SITE_ACTIVITY_LIMIT);
      store.set(settingsKey, JSON.stringify(Object.fromEntries(kept)));
    },
    listForDate(dateIso) {
      return Object.values(read()).filter((entry) => entry.report.date_iso === dateIso);
    },
  };
}
