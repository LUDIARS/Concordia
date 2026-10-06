import { z } from "zod";
import { excubitorBaseUrl } from "../config/service-urls.js";
import type { StatusSnapshot } from "./policy.js";

const MeshSchema = z.object({
  generated_at: z.number().finite().nonnegative(),
  stale_after_ms: z.number().finite().positive().max(7 * 24 * 60 * 60 * 1_000),
  nodes: z.array(z.object({
    node: z.string().min(1).max(200),
    peer_id: z.string().min(1).max(200).nullable(),
    is_self: z.boolean(),
    status: z.string().max(50),
    stale: z.boolean(),
    scan_completed_at: z.number().finite().nonnegative().nullable(),
  })).max(256),
  coverage: z.array(z.object({
    code: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    project_code: z.string().max(200).nullable(),
    repository: z.string().max(1_000).nullable().optional(),
    nodes: z.array(z.object({
      node: z.string().min(1).max(200),
      covered: z.boolean(),
      health: z.enum(["up", "down", "unknown", "unmonitored"]),
      checked_at: z.number().finite().nonnegative().nullable(),
      stale: z.boolean(),
    })).max(256),
  })).max(2_048),
});

/** @implements CC-SS-01 CC-SS-04 — only read Ex's already collected mesh observations. */
export function parseMesh(raw: unknown): StatusSnapshot {
  const mesh = MeshSchema.parse(raw);
  if (new Set(mesh.nodes.map((node) => node.node)).size !== mesh.nodes.length) throw new Error("ambiguous_site_identity");
  const sites = mesh.nodes.map((node) => ({ id: node.is_self ? "self" : `peer:${node.peer_id}`, name: node.node,
    self: node.is_self, connected: node.status === "up", stale: node.stale || node.scan_completed_at === null
      || node.scan_completed_at > mesh.generated_at
      || mesh.generated_at - node.scan_completed_at > mesh.stale_after_ms }));
  if (sites.some((site) => site.id === "peer:null") || new Set(sites.map((site) => site.id)).size !== sites.length) throw new Error("ambiguous_site_identity");
  const siteByName = new Map(sites.map((site) => [site.name, site]));
  const services: StatusSnapshot["services"] = [];
  const serviceKeys = new Set<string>();
  for (const row of mesh.coverage) {
    for (const node of row.nodes) {
      const site = siteByName.get(node.node);
      if (!site || !node.covered) continue;
      const key = `${site.id}\u0000${row.code}`;
      if (serviceKeys.has(key)) throw new Error("ambiguous_service_identity");
      if (services.length >= 1_000) throw new Error("service_status_too_large");
      serviceKeys.add(key);
      services.push({ siteId: site.id, code: row.code, name: row.name, project: row.project_code,
        repository: row.repository ?? null, state: node.stale ? "unknown" : node.health, checkedAt: node.checked_at });
    }
  }
  return { generatedAt: mesh.generated_at, staleAfterMs: mesh.stale_after_ms, sites, services };
}

export class StatusClient {
  private cached: { at: number; snapshot: StatusSnapshot } | null = null;
  private pending: Promise<StatusSnapshot> | null = null;
  constructor(private readonly read: () => Promise<unknown>, private readonly now = Date.now) {}
  get(): Promise<StatusSnapshot> {
    if (this.cached && this.now() - this.cached.at < 15_000) return Promise.resolve(this.cached.snapshot);
    if (this.pending) return this.pending;
    this.pending = this.read().then((raw) => {
      const snapshot = parseMesh(raw); this.cached = { at: this.now(), snapshot }; return snapshot;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
export const serviceStatusClient = new StatusClient(async () => {
  const response = await fetch(`${excubitorBaseUrl()}/api/v1/federation/mesh`, { signal: AbortSignal.timeout(8_000), redirect: "error" });
  if (!response.ok) throw new Error("service_status_unavailable");
  return response.json();
});
