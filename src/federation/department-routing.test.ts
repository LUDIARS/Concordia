import { describe, expect, it, vi } from "vitest";
import { reportError } from "../errors.js";
import { authorizeEgressRequest, resolveDepartmentRoute } from "./department-routing.js";
import type { FederationSitesRepo } from "../db/federation-sites-repo.js";

vi.mock("../errors.js", () => ({ reportError: vi.fn() }));

function sites(rows: Array<{ site_id: string; status?: "active" | "revoked"; departments: string[] }>): FederationSitesRepo {
  return {
    list: () => rows.map((row) => ({
      ...row,
      status: row.status ?? "active",
      name: null, token_enc: "", created_at: 0, revoked_at: null, last_connected_at: null, last_seen_at: null, site_version: null,
    })),
    find: () => null, create: () => { throw new Error("unused"); }, verifyToken: () => false,
    revoke: () => false, touchConnected: () => {}, touchSeen: () => {}, setDepartments: () => false,
  };
}

describe("department routing", () => {
  it("routes an assigned guild to exactly its site", () => {
    expect(resolveDepartmentRoute(sites([{ site_id: "site-a", departments: ["guild-a"] }]), "guild-a"))
      .toEqual({ kind: "site", siteId: "site-a" });
  });

  it("keeps an unassigned guild at HQ", () => {
    expect(resolveDepartmentRoute(sites([{ site_id: "site-a", departments: ["guild-a"] }]), "guild-b"))
      .toEqual({ kind: "hq" });
  });

  it("does not duplicate-deliver a multiply assigned guild and falls back to HQ", () => {
    expect(resolveDepartmentRoute(sites([
      { site_id: "site-a", departments: ["guild-a"] },
      { site_id: "site-b", departments: ["guild-a"] },
    ]), "guild-a")).toEqual({ kind: "hq" });
  });
});

describe("egress authorization", () => {
  const request = { guild_id: "g1", channel_id: "c1" };

  it("allows a site to post into its own department", () => {
    const repo = sites([{ site_id: "site-a", departments: ["g1"] }]);
    expect(authorizeEgressRequest(repo, "site-a", request)).toEqual({ ok: true });
  });

  it("denies a destination that belongs to another site", () => {
    // 1 拠点のトークン漏洩が全部署への投稿権限にならないための境界。
    const repo = sites([
      { site_id: "site-a", departments: ["g1"] },
      { site_id: "site-b", departments: ["g2"] },
    ]);
    const decision = authorizeEgressRequest(repo, "site-b", request);
    expect(decision.ok).toBe(false);
    expect(reportError).toHaveBeenCalled();
  });

  it("denies a destination no site is assigned to (HQ-owned department)", () => {
    const repo = sites([{ site_id: "site-a", departments: ["g2"] }]);
    expect(authorizeEgressRequest(repo, "site-a", request).ok).toBe(false);
  });

  it("denies a revoked site even for its former department", () => {
    const repo = sites([{ site_id: "site-a", status: "revoked", departments: ["g1"] }]);
    expect(authorizeEgressRequest(repo, "site-a", request).ok).toBe(false);
  });

  it("denies while an assignment is duplicated (route falls back to HQ)", () => {
    // 重複時は本社へ戻る = どの拠点も担当ではない。曖昧なまま実行させない。
    const repo = sites([
      { site_id: "site-a", departments: ["g1"] },
      { site_id: "site-b", departments: ["g1"] },
    ]);
    expect(authorizeEgressRequest(repo, "site-a", request).ok).toBe(false);
  });
});
