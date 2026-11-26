import { describe, expect, it } from "vitest";
import { evaluateGeo, isLoopbackAddress, maskIp, parseAllowedCountries, parseGeoPolicy, type GeoInput } from "./geo-policy.js";

const base: GeoInput = {
  cfCountry: "JP",
  cfConnectingIp: "203.0.113.45",
  remoteAddress: "127.0.0.1",
  allowedCountries: ["JP"],
  policy: "block",
};

describe("GLab-UnityHub 海外監視", () => {
  it("許可国からの Cloudflare 経由は通す", () => {
    expect(evaluateGeo(base)).toMatchObject({ allow: true, reason: "allowed_country", overseas: false, country: "JP", maskedIp: "203.0.113.*" });
  });

  it("block 方針では許可国外を拒否する", () => {
    expect(evaluateGeo({ ...base, cfCountry: "US" })).toMatchObject({ allow: false, reason: "overseas_blocked", overseas: true, country: "US" });
  });

  it("monitor 方針では許可国外も通して海外として記録対象にする", () => {
    expect(evaluateGeo({ ...base, cfCountry: "US", policy: "monitor" }))
      .toMatchObject({ allow: true, reason: "overseas_monitored", overseas: true });
  });

  it("T1 (Tor) と XX (不明) は許可国外として扱う", () => {
    for (const country of ["T1", "XX"]) {
      expect(evaluateGeo({ ...base, cfCountry: country, allowedCountries: ["JP", country] }).overseas).toBe(true);
    }
  });

  it("CF ヘッダが無く送信元が loopback 以外なら拒否する", () => {
    expect(evaluateGeo({ ...base, cfCountry: null, cfConnectingIp: null, remoteAddress: "192.0.2.10" }))
      .toMatchObject({ allow: false, reason: "not_via_cloudflare" });
  });

  it("CF ヘッダが無くても loopback からの開発接続は通す", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(evaluateGeo({ ...base, cfCountry: null, cfConnectingIp: null, remoteAddress: address }).reason).toBe("loopback");
    }
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("IP は末尾を伏せる", () => {
    expect(maskIp("198.51.100.7")).toBe("198.51.100.*");
    expect(maskIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:*");
    expect(maskIp(null)).toBeNull();
  });

  it("設定値の読み取り: 既定は JP と block", () => {
    expect(parseAllowedCountries("")).toEqual(["JP"]);
    expect(parseAllowedCountries("jp, us,T1")).toEqual(["JP", "US"]);
    expect(parseGeoPolicy(undefined)).toBe("block");
    expect(parseGeoPolicy("monitor")).toBe("monitor");
    expect(parseGeoPolicy("weird")).toBe("block");
  });
});
