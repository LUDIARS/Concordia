import { describe, expect, it } from "vitest";
import { clearSsoCookie, hostWithoutPort, isPublicRequest, readSsoCookie, roleAllowed, SSO_COOKIE, ssoCookie } from "./policy.js";

const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];

describe("hostWithoutPort", () => {
  it("ポートを外して小文字にする", () => {
    expect(hostWithoutPort("CC.example.com:443")).toBe("cc.example.com");
    expect(hostWithoutPort("100.84.1.2:11111")).toBe("100.84.1.2");
    expect(hostWithoutPort("[::1]:11111")).toBe("[::1]");
    expect(hostWithoutPort(undefined)).toBe("");
  });
});

describe("isPublicRequest (CC-SSO-INV-03)", () => {
  it("Host が公開ホストなら公開側", () => {
    expect(isPublicRequest("cc.example.com", headers({ host: "cc.example.com" }))).toBe(true);
  });

  it("loopback / Tailscale は今の境界のまま", () => {
    expect(isPublicRequest("cc.example.com", headers({ host: "127.0.0.1:11111" }))).toBe(false);
    expect(isPublicRequest("cc.example.com", headers({ host: "100.84.1.2:11111" }))).toBe(false);
  });

  it("Host を変えてもトンネル由来のヘッダーがあれば公開側", () => {
    for (const name of ["cf-ray", "cf-connecting-ip", "cf-access-jwt-assertion"]) {
      expect(isPublicRequest("cc.example.com", headers({ host: "127.0.0.1:11111", [name]: "x" }))).toBe(true);
    }
  });
});

describe("roleAllowed (CC-SSO-INV-04)", () => {
  it("owner / admin だけ", () => {
    expect(roleAllowed("owner")).toBe(true);
    expect(roleAllowed("admin")).toBe(true);
    expect(roleAllowed("member")).toBe(false);
    expect(roleAllowed("")).toBe(false);
    expect(roleAllowed(undefined)).toBe(false);
  });
});

describe("SSO Cookie", () => {
  it("__Host- の条件 (Secure・Path=/・Domain 無し) と HttpOnly・SameSite=Lax で置く", () => {
    const cookie = ssoCookie("tok en", 120.7);
    expect(cookie).toBe(`${SSO_COOKIE}=tok%20en; Path=/; Max-Age=120; Secure; HttpOnly; SameSite=Lax`);
    expect(cookie).not.toMatch(/Domain=/);
    expect(ssoCookie("t", -5)).toMatch(/Max-Age=0;/);
    expect(clearSsoCookie()).toMatch(/^__Host-cc-sso=; Path=\/; Max-Age=0;/);
  });

  it("Cookie ヘッダーから自分の名前だけを読む", () => {
    expect(readSsoCookie(`a=1; ${SSO_COOKIE}=tok%20en; b=2`)).toBe("tok en");
    expect(readSsoCookie("cc-sso=other")).toBe("");
    expect(readSsoCookie(undefined)).toBe("");
    expect(readSsoCookie(`${SSO_COOKIE}=%E0%A4%A`)).toBe("");
  });
});
