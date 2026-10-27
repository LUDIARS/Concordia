/**
 * 本社が拠点から受け取った週間使用量の台帳 (SPEC-FED-SITE-USAGE)。
 *
 * 拠点ごとに最新 1 件だけを持つ (後着で上書き)。 Cc 再起動直後もコストチャンネルに出せるよう
 * SettingsStore (schema_meta) に JSON で置く。
 *
 * @implements spec/feature/federation-link.md SPEC-FED-SITE-USAGE
 */
import type { SettingsStore } from "../admin/settings-store.js";
import type { SiteUsageEntry, SiteUsageReport } from "./site-usage.js";

export const HQ_SITE_USAGE_KEY = "federation.hq.site_usage";

export interface SiteUsageStore {
  record(siteId: string, siteName: string, report: SiteUsageReport, receivedAt?: number): void;
  list(): SiteUsageEntry[];
}

function isEntry(value: unknown): value is SiteUsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SiteUsageEntry>;
  return typeof entry.site_id === "string"
    && typeof entry.site_name === "string"
    && typeof entry.received_at === "number"
    && Boolean(entry.report)
    && typeof entry.report?.generated_at === "number"
    && Array.isArray(entry.report?.providers);
}

export function createSiteUsageStore(store: Pick<SettingsStore, "get" | "set">, settingsKey = HQ_SITE_USAGE_KEY): SiteUsageStore {
  const read = (): Record<string, SiteUsageEntry> => {
    const entries = Object.create(null) as Record<string, SiteUsageEntry>;
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
      if (!siteId) throw new Error("site usage requires a site id");
      const all = read();
      all[siteId] = { site_id: siteId, site_name: siteName || siteId, received_at: receivedAt, report };
      store.set(settingsKey, JSON.stringify(all));
    },
    list() {
      return Object.values(read()).sort((a, b) => a.site_name.localeCompare(b.site_name));
    },
  };
}
