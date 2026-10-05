/**
 * Session forum の拠点タグ → 実行先拠点の解決 (spec/feature/federation-link.md
 * 「拠点タグによる実行先指定」)。
 *
 * 判定だけを純関数に切り出すのは、Discord / Villa / DB を持ち込まずに
 * 「曖昧・失効・未対応づけ」の退避先をテストで固定するため。
 */

import type { FederationSiteRow } from "../db/federation-sites-repo.js";
import type { VillaPc } from "../villa/client.js";
import type { DepartmentRoute } from "./department-routing.js";

export interface ForumSiteRouteResolution { route: DepartmentRoute | null; warnings: string[]; }

/** Forum のPC名は Villa の一覧からだけ解釈し、作業種別等の既存タグを誤解釈しない。 */
export function resolveSiteFromForumTags(
  sites: readonly FederationSiteRow[], villaPcs: readonly VillaPc[], appliedTagNames: readonly string[],
): ForumSiteRouteResolution {
  const pcsByName = new Map(villaPcs.map((pc) => [pc.name, pc]));
  const selected = [...new Set(appliedTagNames.filter((name) => pcsByName.has(name)))];
  if (selected.length === 0) return { route: null, warnings: [] };
  if (selected.length > 1) return { route: { kind: "hq" }, warnings: [`複数の拠点タグが指定されています: ${selected.join(", ")}`] };
  const pc = pcsByName.get(selected[0]!)!;
  const matches = sites.filter((site) => site.villa_pc_id === pc.id);
  const active = matches.filter((site) => site.status === "active");
  if (active.length === 1) return { route: { kind: "site", siteId: active[0]!.site_id }, warnings: [] };
  if (matches.some((site) => site.status === "revoked")) {
    return { route: null, warnings: [`拠点タグ ${pc.name} は失効済み拠点に対応しています`] };
  }
  return { route: null, warnings: [`拠点タグ ${pc.name} に有効な拠点対応がありません`] };
}

/** Discord のタグ名上限。超える拠点名はタグにしない (mergeForumSiteTags も同じ上限で弾く)。 */
const MAX_TAG_NAME = 20;

/** Villa から PC 一覧が取れないときの拠点タグ: 有効な拠点の表示名 (無ければ site_id)。 */
export function siteNameTag(site: FederationSiteRow): string {
  return (site.name?.trim() || site.site_id).slice(0, MAX_TAG_NAME);
}

export function siteNameTagsOf(sites: readonly FederationSiteRow[]): string[] {
  return [...new Set(sites.filter((site) => site.status === "active").map(siteNameTag))];
}

/**
 * Villa 不在時の解決。拠点名タグが 1 個だけ付いていればその拠点、複数なら本社へ退避する。
 * 同名の有効拠点が複数あるときも曖昧として本社へ退避する。
 */
export function resolveSiteFromSiteNameTags(
  sites: readonly FederationSiteRow[], appliedTagNames: readonly string[],
): ForumSiteRouteResolution {
  const active = sites.filter((site) => site.status === "active");
  const selected = [...new Set(appliedTagNames.filter((name) => active.some((site) => siteNameTag(site) === name)))];
  if (selected.length === 0) return { route: null, warnings: [] };
  if (selected.length > 1) return { route: { kind: "hq" }, warnings: [`複数の拠点タグが指定されています: ${selected.join(", ")}`] };
  const matches = active.filter((site) => siteNameTag(site) === selected[0]);
  if (matches.length === 1) return { route: { kind: "site", siteId: matches[0]!.site_id }, warnings: [] };
  return { route: { kind: "hq" }, warnings: [`拠点タグ ${selected[0]} に同名の拠点が複数あります`] };
}
