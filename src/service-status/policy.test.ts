import { describe, expect, it } from "vitest";
import { projectStatus, statusCandidates, statusChanges, statusServiceKey, type StatusSnapshot } from "./policy.js";
import { createServiceVisibilityPolicy } from "./visibility.js";

const now = 1_000_000;
const visibility = createServiceVisibilityPolicy({
  restrictedSites: ["restricted-site"],
  restrictedServices: ["rp"],
  restrictedServicePrefixes: ["restricted-service", "restricted-project"],
  headOfficeOnlyServices: ["ho"],
  headOfficeOnlyServicePrefixes: ["head-office-only"],
});
export const snapshot = (): StatusSnapshot => ({ generatedAt: now, staleAfterMs: 60_000,
  sites: [
    { id: "self", name: "HQ", self: true, connected: true, stale: false },
    { id: "peer:glab", name: "GLAB", self: false, connected: true, stale: false },
    { id: "peer:restricted", name: "Restricted Site", self: false, connected: true, stale: false },
  ], services: [
    { siteId: "self", code: "concordia", name: "Concordia", project: "Cc", repository: "LUDIARS/Concordia", state: "up", checkedAt: now },
    { siteId: "self", code: "head-office-only", name: "Head office only", project: "Ho", repository: "internal/head-office-only", state: "up", checkedAt: now },
    { siteId: "peer:glab", code: "glab", name: "GLAB", project: "glab", repository: "LUDIARS/GLAB", state: "up", checkedAt: now },
    { siteId: "peer:glab", code: "head-office-only", name: "Head office only", project: "Ho", repository: null, state: "up", checkedAt: now },
    { siteId: "peer:restricted", code: "secret-service", name: "Private service", project: null, repository: null, state: "up", checkedAt: now },
    ...["rp", "restricted-service", "restricted-project"].map((code) => ({ siteId: "peer:glab", code, name: code, project: code, repository: null, state: "up" as const, checkedAt: now })),
  ] });

describe("service visibility", () => {
  it("HQ sees every fresh running service; a subsidiary cannot force private sites/projects via settings", () => {
    const data = snapshot();
    expect(projectStatus(data, null, now, visibility).running).toHaveLength(8);
    const result = projectStatus(data, { sites: data.sites.map((s) => s.id),
      services: data.services.map((s) => statusServiceKey(s.siteId, s.code)) }, now, visibility);
    expect(result.running.map((s) => `${s.siteId}/${s.code}`)).toEqual(["self/concordia", "peer:glab/glab", "peer:glab/head-office-only"]);
    expect(JSON.stringify(result)).not.toContain("Restricted Site");
    expect(JSON.stringify(result)).not.toContain("Private service");
    expect(projectStatus(data, null, now, visibility).services.every((service) => service.repository === null && service.project === null)).toBe(true);
  });
  it("requires both filters, defaults empty, and removes private candidates before counts", () => {
    const data = snapshot();
    expect(projectStatus(data, { sites: [], services: [] }, now, visibility).services).toEqual([]);
    expect(projectStatus(data, { sites: ["peer:glab"], services: [statusServiceKey("self", "concordia")] }, now, visibility).running).toEqual([]);
    const choices = statusCandidates(data, ["self", "peer:restricted"], visibility);
    expect(choices.sites.map((s) => s.name)).toEqual(["HQ", "GLAB"]);
    expect(choices.services.map((s) => s.code)).toEqual(["concordia"]);
  });
  it("keeps equal service codes on different sites as separate selectable identities", () => {
    const data = snapshot();
    data.services.push({ ...data.services[0]!, siteId: "peer:glab", name: "Concordia replica" });
    const choices = statusCandidates(data, ["self", "peer:glab"], visibility);
    expect(choices.services.filter((service) => service.code === "concordia").map((service) => service.key))
      .toEqual([statusServiceKey("self", "concordia"), statusServiceKey("peer:glab", "concordia")]);
  });
  it("private repository/name wins over an apparently public code", () => {
    for (const name of ["restricted-service", "restricted-project", "rp"]) {
      const data = snapshot(); data.services = [{ ...data.services[0]!, project: "public", code: "public", name: "public", repository: `LUDIARS/${name}` }];
      expect(projectStatus(data, { sites: ["self"], services: [statusServiceKey("self", "public")] }, now, visibility).services).toEqual([]);
      data.services[0]!.repository = `synthetic\\${name}`;
      expect(projectStatus(data, { sites: ["self"], services: [statusServiceKey("self", "public")] }, now, visibility).services).toEqual([]);
    }
  });
  it("old observations, disconnected sites and old snapshots never imply running", () => {
    const data = snapshot(); data.sites[1]!.connected = false; data.services[0]!.checkedAt = now - 60_001;
    expect(projectStatus(data, null, now, visibility).running.map((s) => s.code)).not.toContain("glab");
    expect(projectStatus(data, null, now, visibility).running.map((s) => s.code)).not.toContain("concordia");
    expect(projectStatus(data, null, now + 60_001, visibility).running).toEqual([]);
    data.services[0]!.checkedAt = now + 1;
    expect(projectStatus(data, null, now, visibility).running.map((s) => s.code)).not.toContain("concordia");
  });
  it("does not fabricate stop events when settings remove a service", () => {
    expect(statusChanges(snapshot().services, [])).toEqual([]);
    expect(statusChanges(null, snapshot().services)).toEqual([]);
    const next = snapshot().services; next[0]!.state = "down";
    expect(statusChanges(snapshot().services, next)).toEqual([expect.objectContaining({ code: "concordia", before: "up", after: "down" })]);
  });
});
