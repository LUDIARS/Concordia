/**
 * 拠点ごとの担当プロジェクト (2026-10-07 neco 指示「プロジェクトと関連させて自動で対象のマシンで動作させる」)。
 *
 * `/spawn` の project から起動先の拠点を決めるための対応表。 Cc の設定ストアに
 * `{ [siteId]: projectCode[] }` を 1 キーで持つ (federation_sites の列は増やさない)。
 * 業務判断 (どの拠点か) は forum-site-routing.ts の純関数が持ち、 ここは読み書きだけを担う。
 */
import type { SettingsStore } from "../admin/settings-store.js";

export const SITE_PROJECTS_SETTINGS_KEY = "federation.site_projects";

export type SiteProjectAssignments = Readonly<Record<string, readonly string[]>>;

export interface SiteProjectsStore {
  all(): SiteProjectAssignments;
  get(siteId: string): string[];
  set(siteId: string, projects: readonly string[]): string[];
}

export function createSiteProjectsStore(settings: Pick<SettingsStore, "get" | "set">): SiteProjectsStore {
  const read = (): Record<string, string[]> => {
    try {
      const parsed = JSON.parse(settings.get(SITE_PROJECTS_SETTINGS_KEY) ?? "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([siteId, list]) => [siteId, list.filter((value): value is string => typeof value === "string")]));
    } catch {
      return {}; // 壊れた値は「対応なし」= 本社で起動 (拠点へ推測で渡さない)。
    }
  };
  return {
    all: read,
    get: (siteId) => read()[siteId] ?? [],
    set(siteId, projects) {
      const normalized = [...new Set(projects.map((project) => project.trim()).filter(Boolean))];
      const next = read();
      if (normalized.length === 0) delete next[siteId];
      else next[siteId] = normalized;
      settings.set(SITE_PROJECTS_SETTINGS_KEY, JSON.stringify(next));
      return normalized;
    },
  };
}
