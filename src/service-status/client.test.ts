import { describe, expect, it, vi } from "vitest";
import { parseMesh, StatusClient } from "./client.js";
const mesh = () => ({ generated_at: 100, stale_after_ms: 1000,
  nodes: [{ node: "HQ", peer_id: null, is_self: true, status: "up", stale: false, scan_completed_at: 100 }],
  coverage: [{ code: "cc", name: "Cc", project_code: "Cc", repository: "LUDIARS/Concordia",
    nodes: [{ node: "HQ", covered: true, health: "up", checked_at: 100, stale: false }] }],
});
describe("Ex status cache client", () => {
  it("projects only minimal fields; no topology credentials or peer errors escape", () => {
    const data = { ...mesh(), secret: "not exposed", links: [{ url: "secret" }] };
    expect(parseMesh(data)).toEqual({ generatedAt: 100, staleAfterMs: 1000,
      sites: [{ id: "self", name: "HQ", self: true, connected: true, stale: false }],
      services: [{ siteId: "self", code: "cc", name: "Cc", project: "Cc", repository: "LUDIARS/Concordia", state: "up", checkedAt: 100 }] });
  });
  it("rejects ambiguous site identity and never treats missing scan as fresh", () => {
    const data = mesh(); data.nodes.push({ ...data.nodes[0]! });
    expect(() => parseMesh(data)).toThrow("ambiguous_site_identity");
    expect(parseMesh({ ...mesh(), nodes: [{ ...mesh().nodes[0], scan_completed_at: null }] }).sites[0]!.stale).toBe(true);
    expect(parseMesh({ ...mesh(), nodes: [{ ...mesh().nodes[0], scan_completed_at: 101 }] }).sites[0]!.stale).toBe(true);
    const duplicateService = mesh(); duplicateService.coverage.push({ ...duplicateService.coverage[0]! });
    expect(() => parseMesh(duplicateService)).toThrow("ambiguous_service_identity");
  });
  it("coalesces requests across bots and refuses to return stale cached success on a refresh failure", async () => {
    let now = 0; const read = vi.fn().mockResolvedValue(mesh()); const client = new StatusClient(read, () => now);
    await Promise.all([client.get(), client.get(), client.get()]); expect(read).toHaveBeenCalledTimes(1);
    now = 15_001; read.mockRejectedValue(new Error("offline"));
    await expect(client.get()).rejects.toThrow("offline");
  });
});
