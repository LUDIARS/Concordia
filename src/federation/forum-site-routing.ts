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
