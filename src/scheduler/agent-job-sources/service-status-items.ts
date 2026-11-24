/**
 * Excubitor のサービス稼働の観測 (service-status の StatusSnapshot) を日報の data に写す。 拠点名は渡さない。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 読み取り adapter (日報)
 */

import type { StatusSnapshot } from "../../service-status/policy.js";
import type { ServiceStatusItem } from "../agent-jobs/ludiars-status-daily.js";

export function toServiceStatusItems(snapshot: StatusSnapshot): ServiceStatusItem[] {
  const selfSites = new Set(snapshot.sites.filter((site) => site.self).map((site) => site.id));
  return snapshot.services.map((service) => ({
    code: service.code,
    name: service.name,
    project: service.project,
    state: service.state,
    self: selfSites.has(service.siteId),
  }));
}
