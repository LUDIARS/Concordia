import { reportError } from "../errors.js";
import type { FederationSitesRepo } from "../db/federation-sites-repo.js";

export type DepartmentRoute = { kind: "hq" } | { kind: "site"; siteId: string };

/**
 * 同じ guild を複数拠点へ複製すると、同一入力が二重に実行される。
 * そのため矛盾時は必ず本社へ戻し、エラーを残す。
 */
export function resolveDepartmentRoute(sites: FederationSitesRepo, guildId: string): DepartmentRoute {
  const matches = sites.list()
    .filter((site) => site.status === "active" && site.departments.includes(guildId));
  if (matches.length === 1) return { kind: "site", siteId: matches[0]!.site_id };
  if (matches.length > 1) {
    reportError("federation", "部署割当が複数拠点に重複しているため本社へフォールバックしました", {
      guild_id: guildId,
      site_ids: matches.map((site) => site.site_id),
    });
  }
  return { kind: "hq" };
}

export type EgressAuthorization = { ok: true } | { ok: false; error: string };

/**
 * 拠点からの egress 要求を、その拠点の担当部署に閉じる。
 *
 * これが無いと 1 拠点の連合トークン漏洩が全部署への投稿権限になる
 * (spec/plan/multi-site-federation.md の egress 節が明示する不変条件)。
 * 判定を listener のクロージャに埋めず独立関数にしてあるのは、
 * 「担当外は拒否される」がテストで固定できる性質であるべきだから。
 * 拒否は必ず監査に残す — 黙って false を返すと、権限外要求が起きたこと自体が
 * どこにも残らない。
 */
export function authorizeEgressRequest(
  sites: FederationSitesRepo,
  siteId: string,
  request: { guild_id: string; channel_id: string },
): EgressAuthorization {
  const route = resolveDepartmentRoute(sites, request.guild_id);
  if (route.kind === "site" && route.siteId === siteId) return { ok: true };
  reportError(
    "federation",
    `担当外 egress を拒否しました site=${siteId} guild=${request.guild_id} channel=${request.channel_id}`,
    { site_id: siteId, guild_id: request.guild_id, channel_id: request.channel_id },
  );
  return { ok: false, error: "destination is outside this site's department" };
}
