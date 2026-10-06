import { z } from "zod";
import { excubitorBaseUrl } from "../config/service-urls.js";
import type { StatusSnapshot } from "./policy.js";

const RegisteredPeerSchema = z.object({ id: z.string().min(1).max(200), name: z.string().trim().min(1).max(200), enabled: z.boolean() });
const PeersSchema = z.object({ peers: z.array(RegisteredPeerSchema).max(256) });
const MeshSchema = z.object({
  registered_peers: z.array(RegisteredPeerSchema).max(256).optional(),
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

/** @implements spec/feature/service-status-channel.md CC-SS-01 CC-SS-04 CC-SS-07 — read Ex's cached observations and local registrations. */
export function parseMesh(raw: unknown): StatusSnapshot {
  const mesh = MeshSchema.parse(raw);
  const registered = new Map((mesh.registered_peers ?? []).map((peer) => [peer.id, peer]));
  if (registered.size !== (mesh.registered_peers ?? []).length) throw new Error("ambiguous_registered_site");
  if (new Set(mesh.nodes.map((node) => node.node)).size !== mesh.nodes.length) throw new Error("ambiguous_site_identity");
  const sites = mesh.nodes.map((node) => {
    const peer = node.peer_id === null ? undefined : registered.get(node.peer_id);
    if (!node.is_self && (!peer || !peer.enabled)) throw new Error("registered_site_unavailable");
    return { id: node.is_self ? "self" : `peer:${node.peer_id}`, name: node.is_self ? node.node : peer!.name,
    self: node.is_self, connected: node.status === "up", stale: node.stale || node.scan_completed_at === null
      || node.scan_completed_at > mesh.generated_at
      || mesh.generated_at - node.scan_completed_at > mesh.stale_after_ms };
  });
  if (sites.some((site) => site.id === "peer:null") || new Set(sites.map((site) => site.id)).size !== sites.length) throw new Error("ambiguous_site_identity");
  // Coverage is keyed by the observed hostname, never by the operator's display label.
  const siteByName = new Map(mesh.nodes.map((node, index) => [node.node, sites[index]!]));
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
  const base = excubitorBaseUrl();
  const signal = AbortSignal.timeout(8_000);
  const [meshResponse, peerResponse] = await Promise.all([
    fetch(`${base}/api/v1/federation/mesh`, { signal, redirect: "error" }),
    fetch(`${base}/api/v1/peers`, { signal, redirect: "error" }),
  ]);
  if (!meshResponse.ok || !peerResponse.ok) throw new Error("service_status_unavailable");
  const mesh = MeshSchema.parse(await meshResponse.json());
  const peers = PeersSchema.parse(await peerResponse.json());
  return { ...mesh, registered_peers: peers.peers };
});
