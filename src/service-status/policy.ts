/** @implements CC-SS-02 CC-SS-03 CC-SS-04 */
import {
  defaultServiceVisibilityPolicy,
  publicService,
  publicSite,
  type ServiceVisibilityPolicy,
} from "./visibility.js";

export interface StatusSite { id: string; name: string; self: boolean; connected: boolean; stale: boolean }
export interface StatusService {
  siteId: string; code: string; name: string; project: string | null; repository: string | null;
  state: "up" | "down" | "unknown" | "unmonitored"; checkedAt: number | null;
}
export interface StatusSnapshot { generatedAt: number; staleAfterMs: number; sites: StatusSite[]; services: StatusService[] }
export interface StatusSelection { sites: string[]; services: string[] }
export interface StatusProjection { sites: StatusSite[]; services: StatusService[]; running: StatusService[] }
export const emptySelection = (): StatusSelection => ({ sites: [], services: [] });
export const statusServiceKey = (siteId: string, code: string): string => `${encodeURIComponent(siteId)}/${encodeURIComponent(code)}`;

/** Projection happens before names, counts or transitions are computed. */
export function projectStatus(
  snapshot: StatusSnapshot,
  selection: StatusSelection | null,
  now: number,
  visibility: ServiceVisibilityPolicy = defaultServiceVisibilityPolicy,
): StatusProjection {
  const sites = snapshot.sites.filter((site) => selection === null || (publicSite(site, visibility) && selection.sites.includes(site.id)));
  const byId = new Map(sites.map((site) => [site.id, site]));
  const services = snapshot.services.flatMap((service) => {
    const site = byId.get(service.siteId);
    if (!site || (selection !== null
      && (!selection.services.includes(statusServiceKey(service.siteId, service.code)) || !publicService(service, site, visibility)))) return [];
    const fresh = site.connected && !site.stale && service.checkedAt !== null
      && service.checkedAt <= now && now - service.checkedAt <= snapshot.staleAfterMs
      && snapshot.generatedAt <= now && now - snapshot.generatedAt <= snapshot.staleAfterMs;
    // Source project/repository identifiers are policy inputs, not publication data.
    return [{ ...service, project: null, repository: null, state: fresh ? service.state : "unknown" as const }];
  });
  return { sites, services, running: services.filter((service) => service.state === "up") };
}

export function statusCandidates(
  snapshot: StatusSnapshot,
  siteIds: readonly string[],
  visibility: ServiceVisibilityPolicy = defaultServiceVisibilityPolicy,
) {
  const sites = snapshot.sites.filter((site) => publicSite(site, visibility));
  const allowed = new Map(sites.filter((site) => siteIds.includes(site.id)).map((site) => [site.id, site]));
  const services = [...new Map(snapshot.services.filter((service) => {
    const site = allowed.get(service.siteId);
    return site && publicService(service, site, visibility);
  }).map((service) => {
    const site = allowed.get(service.siteId)!;
    const key = statusServiceKey(service.siteId, service.code);
    return [key, { key, siteId: service.siteId, siteName: site.name, code: service.code, name: service.name }] as const;
  })).values()];
  return { sites: sites.map((site) => ({ id: site.id, name: site.name })), services };
}

export interface StatusChange {
  siteId: string;
  code: string;
  name: string;
  before: StatusService["state"];
  after: StatusService["state"];
}
export function statusChanges(previous: readonly StatusService[] | null, next: readonly StatusService[]): StatusChange[] {
  if (previous === null) return [];
  const old = new Map(previous.map((service) => [statusServiceKey(service.siteId, service.code), service]));
  return next.flatMap((service) => {
    const before = old.get(statusServiceKey(service.siteId, service.code));
    if (!before || before.state === service.state) return [];
    return [{ siteId: service.siteId, code: service.code, name: service.name, before: before.state, after: service.state }];
  });
}
