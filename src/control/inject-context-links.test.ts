import { describe, expect, it, vi } from "vitest";
import { resolveContextLinksForRoot, type ContextLinkPort } from "./inject-context-links.js";
import { repositoryKey } from "../taskflow/actio-binding.js";

const root = repositoryKey("E:/Document/Ars/Concordia");
function port(anatomiaRegistered: boolean, pfRegistered: boolean): ContextLinkPort {
  return {
    verifiedBaseUrl: async (service) => `http://127.0.0.1:${service === "anatomia" ? 4200 : 4300}`,
    request: async (service, path) => {
      if (service === "anatomia") {
        if (!anatomiaRegistered) throw new Error("unregistered");
        if (path === "/api/projects") return { projects: [{ id: "an-cc", rootPath: "E:/Document/Ars/Concordia" }] };
        return { items: [] };
      }
      if (!pfRegistered) throw new Error("unregistered");
      if (path.startsWith("/api/projects?")) return { items: [{ id: "pf-cc", anatomiaRepo: "LUDIARS/Concordia" }], total: 1 };
      return { id: "pf-cc" };
    },
  };
}

describe("registered context links", () => {
  it("handles Pf and An independently", async () => {
    const both = await resolveContextLinksForRoot(root, "LUDIARS/Concordia", port(true, true));
    expect(both.anatomia).toContain("/api/projects/an-cc/domains");
    expect(both.anatomiaProjectId).toBe("an-cc");
    expect(both.anatomiaBaseUrl).toBe("http://127.0.0.1:4200");
    expect(both.praeforma).toContain("/api/projects/pf-cc");
    const onlyPf = await resolveContextLinksForRoot(root, "LUDIARS/Concordia", port(false, true));
    expect(onlyPf.anatomia).toBe("");
    expect(onlyPf.anatomiaProjectId).toBeUndefined();
    expect(onlyPf.praeforma).toContain("/api/projects/pf-cc");
    const onlyAn = await resolveContextLinksForRoot(root, "LUDIARS/Concordia", port(true, false));
    expect(onlyAn.praeforma).toBe("");
    expect(onlyAn.anatomia).toContain("/api/projects/an-cc/domains");
  });

  it("omits ambiguous or unregistered targets", async () => {
    expect(await resolveContextLinksForRoot(null, null, port(false, false))).toEqual({ praeforma: "", anatomia: "" });
  });

  it("keeps Pf registered by An ID when An's domains endpoint fails", async () => {
    const result = await resolveContextLinksForRoot(root, "LUDIARS/Concordia", {
      verifiedBaseUrl: async (service) => `http://127.0.0.1/${service}`,
      request: async (service, path) => {
        if (service === "anatomia") {
          if (path === "/api/projects") return { projects: [{ id: "an-cc", rootPath: "E:/Document/Ars/Concordia" }] };
          throw new Error("domains unavailable");
        }
        return path.startsWith("/api/projects?")
          ? { items: [{ id: "pf-cc", anatomiaRepo: "an-cc" }], total: 1 } : { id: "pf-cc" };
      },
    });
    expect(result.anatomia).toBe("");
    expect(result.praeforma).toContain("/api/projects/pf-cc");
  });

  it("omits ambiguous registrations and URLs without a verified base", async () => {
    const duplicate: ContextLinkPort = {
      verifiedBaseUrl: async () => "http://127.0.0.1",
      request: async (service, path) => service === "anatomia"
        ? { projects: [{ id: "a", rootPath: "E:/Document/Ars/Concordia" }, { id: "b", rootPath: "E:/Document/Ars/Concordia" }] }
        : path.startsWith("/api/projects?")
          ? { items: [{ id: "p1", anatomiaRepo: "LUDIARS/Concordia" }, { id: "p2", anatomiaRepo: "LUDIARS/Concordia" }], total: 2 }
          : { id: "p1" },
    };
    expect(await resolveContextLinksForRoot(root, "LUDIARS/Concordia", duplicate)).toEqual({ praeforma: "", anatomia: "" });
    const noBase = port(true, true);
    noBase.verifiedBaseUrl = async () => null;
    expect(await resolveContextLinksForRoot(root, "LUDIARS/Concordia", noBase)).toEqual({ praeforma: "", anatomia: "" });
  });

  it("treats catalogs above the 300-project observation bound as unconfirmed", async () => {
    const request = vi.fn(async (_service: "praeforma" | "anatomia", path: string) =>
      path.startsWith("/api/projects?") ? { items: [], total: 301 } : { id: "unused" });
    expect((await resolveContextLinksForRoot(null, "LUDIARS/Concordia", {
      request, verifiedBaseUrl: async () => "http://127.0.0.1",
    })).praeforma).toBe("");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
