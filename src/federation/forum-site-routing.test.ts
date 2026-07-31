import { describe, expect, it } from "vitest";
import { resolveSiteFromForumTags } from "./forum-site-routing.js";
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
