import { describe, expect, it, vi } from "vitest";
import { CernereRejectedError, CernereUnavailableError } from "./cernere-project-channel.js";
import type { EnterpriseSessionInfo } from "./enterprise-session-client.js";
import { decideAccess, type GateOptions } from "./gate.js";
import { SSO_COOKIE } from "./policy.js";

const NOW = 1_800_000_000;
const session = (role = "admin", projectKey = "concordia"): EnterpriseSessionInfo => ({
  userId: "u1", projectKey, organizationId: "org", organizationRole: role, expiresAt: NOW + 600,
});
const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];
const PUBLIC = { host: "cc.example.com" };

function options(client: Partial<GateOptions["client"]>, extra: Partial<GateOptions> = {}): GateOptions {
  return {
    publicHost: "cc.example.com",
    projectKey: "concordia",
    client: {
      login: client.login ?? vi.fn(async () => { throw new Error("login not expected"); }),
      verify: client.verify ?? vi.fn(async () => { throw new Error("verify not expected"); }),
    },
    now: () => NOW,
    ...extra,
  };
}

describe("decideAccess", () => {
  it("公開側でなければ Cernere に問い合わせず今の境界のまま (CC-SSO-INV-03)", async () => {
    const verify = vi.fn();
    const decision = await decideAccess(headers({ host: "127.0.0.1:11111", cookie: `${SSO_COOKIE}=t` }), options({ verify }));
    expect(decision).toEqual({ kind: "local" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("Cookie の企業セッションを Cernere で verify して通す", async () => {
    const verify = vi.fn(async () => session("owner"));
    const decision = await decideAccess(headers({ ...PUBLIC, cookie: `${SSO_COOKIE}=tok` }), options({ verify }));
    expect(decision).toMatchObject({ kind: "allow", session: { userId: "u1" } });
    expect(verify).toHaveBeenCalledWith("tok");
  });

  it("Cookie が無ければ Access JWT を Cernere に渡して login し、Cookie を置く (CC-SSO-INV-02)", async () => {
    const login = vi.fn(async () => ({ enterpriseToken: "new-token", session: session() }));
    const decision = await decideAccess(headers({ ...PUBLIC, "cf-access-jwt-assertion": "jwt" }), options({ login }));
    expect(login).toHaveBeenCalledWith("jwt");
    expect(decision).toMatchObject({ kind: "allow" });
    if (decision.kind !== "allow") throw new Error("unreachable");
    expect(decision.setCookie).toMatch(new RegExp(`^${SSO_COOKIE}=new-token; Path=/; Max-Age=600;`));
  });

  it("失効した Cookie は消して、JWT があれば login し直す", async () => {
    const verify = vi.fn(async () => { throw new CernereRejectedError("expired"); });
    const login = vi.fn(async () => ({ enterpriseToken: "again", session: session() }));
    const decision = await decideAccess(
      headers({ ...PUBLIC, cookie: `${SSO_COOKIE}=old`, "cf-access-jwt-assertion": "jwt" }),
      options({ verify, login }),
    );
    expect(decision).toMatchObject({ kind: "allow" });
    expect(login).toHaveBeenCalledWith("jwt");
  });

  it("Cookie も JWT も無ければ 401", async () => {
    const decision = await decideAccess(headers(PUBLIC), options({}));
    expect(decision).toMatchObject({ kind: "deny", status: 401 });
  });

  it("owner / admin 以外は 403 (CC-SSO-INV-04)", async () => {
    const verify = vi.fn(async () => session("member"));
    const decision = await decideAccess(headers({ ...PUBLIC, cookie: `${SSO_COOKIE}=tok` }), options({ verify }));
    expect(decision).toMatchObject({ kind: "deny", status: 403 });
  });

  it("別アプリ向けの企業セッションは 403", async () => {
    const verify = vi.fn(async () => session("owner", "other"));
    const decision = await decideAccess(headers({ ...PUBLIC, cookie: `${SSO_COOKIE}=tok` }), options({ verify }));
    expect(decision).toMatchObject({ kind: "deny", status: 403 });
  });

  it("Cernere が login を拒否したら 403、Cookie は置かない", async () => {
    const login = vi.fn(async () => { throw new CernereRejectedError("not assigned"); });
    const decision = await decideAccess(headers({ ...PUBLIC, "cf-access-jwt-assertion": "jwt" }), options({ login }));
    expect(decision).toMatchObject({ kind: "deny", status: 403 });
    expect(decision.kind === "deny" && decision.setCookie).toBeFalsy();
  });

  it("Cernere に届かなければ 503 で拒否し、ローカル判定へ落とさない (CC-SSO-INV-01)", async () => {
    const verify = vi.fn(async () => { throw new CernereUnavailableError("down"); });
    const login = vi.fn();
    const decision = await decideAccess(
      headers({ ...PUBLIC, cookie: `${SSO_COOKIE}=tok`, "cf-access-jwt-assertion": "jwt" }),
      options({ verify, login }),
    );
    expect(decision).toMatchObject({ kind: "deny", status: 503 });
    expect(login).not.toHaveBeenCalled();
  });

  it("WS の upgrade (allowLogin=false) では login せず 401", async () => {
    const login = vi.fn();
    const decision = await decideAccess(
      headers({ ...PUBLIC, "cf-access-jwt-assertion": "jwt" }),
      options({ login }, { allowLogin: false }),
    );
    expect(decision).toMatchObject({ kind: "deny", status: 401 });
    expect(login).not.toHaveBeenCalled();
  });
});
