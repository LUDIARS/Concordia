import { describe, expect, it } from "vitest";
import { resolveSiteFromForumTags, resolveSiteFromSiteNameTags, resolveSiteFromText, siteNameTagsOf } from "./forum-site-routing.js";
import type { FederationSiteRow } from "../db/federation-sites-repo.js";

const pcs = [{ id: "pc-a", name: "HASTER" }, { id: "pc-b", name: "YIDHRA" }];
function site(siteId: string, villaPcId: string | null, status: "active" | "revoked" = "active", departments: string[] = []): FederationSiteRow {
  return { site_id: siteId, villa_pc_id: villaPcId, status, departments, name: null, token_enc: "", created_at: 0, revoked_at: null, last_connected_at: null, last_seen_at: null, site_version: null };
}

describe("forum site routing", () => {
  it("routes one site tag to its mapped site", () => {
    expect(resolveSiteFromForumTags([site("site-a", "pc-a")], pcs, ["HASTER"]).route).toEqual({ kind: "site", siteId: "site-a" });
  });
  it("falls back to HQ and warns for two site tags", () => {
    const result = resolveSiteFromForumTags([site("site-a", "pc-a"), site("site-b", "pc-b")], pcs, ["HASTER", "YIDHRA"]);
    expect(result.route).toEqual({ kind: "hq" });
    expect(result.warnings).not.toEqual([]);
  });
  it("treats a revoked site tag as unspecified and warns", () => {
    const result = resolveSiteFromForumTags([site("site-a", "pc-a", "revoked")], pcs, ["HASTER"]);
    expect(result.route).toBeNull();
    expect(result.warnings).not.toEqual([]);
  });
  it("does not mistake an unregistered work tag for a site tag", () => {
    expect(resolveSiteFromForumTags([site("site-a", "pc-a")], pcs, ["実装"]).route).toBeNull();
  });
  it("uses no site route when no site tag is applied", () => {
    expect(resolveSiteFromForumTags([site("site-a", "pc-a")], pcs, []).route).toBeNull();
  });
  it("makes the site tag route available to override department routing", () => {
    expect(resolveSiteFromForumTags([site("site-a", "pc-a", "active", ["guild-a"]), site("site-b", "pc-b")], pcs, ["YIDHRA"]).route)
      .toEqual({ kind: "site", siteId: "site-b" });
  });
});

describe("forum site routing without Villa (site name tags)", () => {
  const named = (siteId: string, name: string | null, status: "active" | "revoked" = "active"): FederationSiteRow =>
    ({ ...site(siteId, null, status), name });
  it("offers active site names (site_id when unnamed) as tags", () => {
    expect(siteNameTagsOf([named("haster", "HASTER"), named("old", "OLD", "revoked"), named("yidhra", null)])).toEqual(["HASTER", "yidhra"]);
  });
  it("routes one site name tag and ignores work tags", () => {
    expect(resolveSiteFromSiteNameTags([named("haster", "HASTER")], ["実装", "HASTER"]).route).toEqual({ kind: "site", siteId: "haster" });
    expect(resolveSiteFromSiteNameTags([named("haster", "HASTER")], ["実装"]).route).toBeNull();
  });
  it("falls back to HQ for two site tags or duplicated names", () => {
    expect(resolveSiteFromSiteNameTags([named("a", "HASTER"), named("b", "YIDHRA")], ["HASTER", "YIDHRA"]).route).toEqual({ kind: "hq" });
    expect(resolveSiteFromSiteNameTags([named("a", "HASTER"), named("b", "HASTER")], ["HASTER"]).route).toEqual({ kind: "hq" });
  });
  it("does not route to a revoked site", () => {
    expect(resolveSiteFromSiteNameTags([named("a", "HASTER", "revoked")], ["HASTER"]).route).toBeNull();
  });
});

describe("forum site routing by naming the site in the request (2026-10-06)", () => {
  const named = (siteId: string, name: string | null, status: "active" | "revoked" = "active"): FederationSiteRow =>
    ({ ...site(siteId, null, status), name });
  const sites = [named("gromac", "GROMAC"), named("haster", "HASTER")];

  it("routes a request that starts with '<site>で' (after project code brackets) or mentions @<site>", () => {
    expect(resolveSiteFromText(sites, "GROMACで ベンチマークを回す", "").route).toEqual({ kind: "site", siteId: "gromac" });
    expect(resolveSiteFromText(sites, "[Cc] gromac で検証", "").route).toEqual({ kind: "site", siteId: "gromac" });
    expect(resolveSiteFromText(sites, "検証", "HASTERで動かしてほしい").route).toEqual({ kind: "site", siteId: "haster" });
    expect(resolveSiteFromText(sites, "検証", "手元では無理なので @haster でお願い").route).toEqual({ kind: "site", siteId: "haster" });
  });

  it("does not route on a passing mention, a revoked site, or a longer word", () => {
    expect(resolveSiteFromText(sites, "検証", "前に GROMAC で動いた件の続き").route).toBeNull();
    expect(resolveSiteFromText([named("gromac", "GROMAC", "revoked")], "GROMACで検証", "").route).toBeNull();
    expect(resolveSiteFromText(sites, "検証", "@gromacx でお願い").route).toBeNull();
  });

  it("falls back to HQ with a warning when two sites are named", () => {
    const result = resolveSiteFromText(sites, "GROMACで検証", "@haster も見て");
    expect(result.route).toEqual({ kind: "hq" });
    expect(result.warnings).not.toEqual([]);
  });
});
