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
 * 依頼文で拠点を名指しした起動 (2026-10-06 neco 指示「GROMAC で xxxx やる、みたいな形で委託もできるように」)。
 * 誤った振り分けを避けるため、形は 2 つに限る: 題名か本文の先頭が「<拠点>で」、または `@<拠点>`。
 * 拠点は有効な拠点の表示名か site_id と大文字小文字を区別せずに照らす。 名指しが 2 つ以上なら本社へ退避して warn する。
 */
export function resolveSiteFromText(
  sites: readonly FederationSiteRow[], title: string, body: string,
): ForumSiteRouteResolution {
  const active = sites.filter((site) => site.status === "active");
  const named = new Set<string>();
  for (const site of active) {
    const names = [...new Set([site.name?.trim(), site.site_id].filter((name): name is string => Boolean(name)))];
    if (names.some((name) => namesSite(name, title, body))) named.add(site.site_id);
  }
  if (named.size === 0) return { route: null, warnings: [] };
  if (named.size > 1) return { route: { kind: "hq" }, warnings: [`依頼文で複数の拠点が名指しされています: ${[...named].join(", ")}`] };
  return { route: { kind: "site", siteId: [...named][0]! }, warnings: [] };
}

function namesSite(name: string, title: string, body: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${escaped}\\s*で`, "i");
  const mention = new RegExp(`(^|\\s)@${escaped}(?![\\w-])`, "i");
  return leading.test(title) || leading.test(body) || mention.test(title) || mention.test(body);
}

/** `/spawn site:` で指定できる拠点 (有効な拠点だけ)。 */
export function spawnSiteChoices(sites: readonly FederationSiteRow[]): Array<{ siteId: string; name: string }> {
  return sites.filter((site) => site.status === "active").map((site) => ({ siteId: site.site_id, name: site.name?.trim() || site.site_id }));
}

/**
 * project を担当する有効な拠点 (2026-10-07 neco 指示「プロジェクトと関連させて自動で対象のマシンで動作させる」)。
 * プロジェクトコードは大文字小文字を区別して照らす (Cc の略称表と同じ規則)。 対応が無ければ空 (本社で起動)。
 */
export function sitesForProject(
  sites: readonly FederationSiteRow[], assignments: Readonly<Record<string, readonly string[]>>, project: string,
): Array<{ siteId: string; name: string }> {
  const key = project.trim();
  if (!key) return [];
  return spawnSiteChoices(sites).filter((site) => (assignments[site.siteId] ?? []).includes(key));
}

export type ExplicitSiteResolution =
  | { ok: true; siteId: string; siteName: string }
  | { ok: false; reason: "unknown_site" | "inactive_site" | "ambiguous_site" };

/**
 * `/spawn site:` の明示指定を拠点に解決する (2026-10-07 neco 指示「spawnコマンドにspawnする拠点を設定できるように」)。
 * site_id を優先し、 無ければ表示名と大文字小文字を区別せずに照らす。 失効済み・同名複数は起動しない (本社へ黙って落とさない)。
 */
export function resolveExplicitSite(sites: readonly FederationSiteRow[], ref: string): ExplicitSiteResolution {
  const key = ref.trim().toLowerCase();
  const byId = sites.filter((site) => site.site_id.toLowerCase() === key);
  const matches = byId.length > 0 ? byId : sites.filter((site) => site.name?.trim().toLowerCase() === key);
  if (matches.length === 0) return { ok: false, reason: "unknown_site" };
  const active = matches.filter((site) => site.status === "active");
  if (active.length === 0) return { ok: false, reason: "inactive_site" };
  if (active.length > 1) return { ok: false, reason: "ambiguous_site" };
  return { ok: true, siteId: active[0]!.site_id, siteName: active[0]!.name?.trim() || active[0]!.site_id };
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
