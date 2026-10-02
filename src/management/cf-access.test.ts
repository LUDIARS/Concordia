import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CfAccessVerifier, decodeJwt, parseCfAccessConfig } from "./cf-access.js";

const TEAM = "https://example.cloudflareaccess.com";
const AUD = "a".repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1" };

function token(payload: Record<string, unknown>, kid = "k1"): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${enc({ alg: "RS256", kid })}.${enc(payload)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

const NOW = 1_800_000_000_000;
const valid = { iss: TEAM, aud: [AUD], exp: NOW / 1000 + 60, common_name: "dots-client-id" };

function verifier(fetchJwks = vi.fn(async () => ({ keys: [jwk] }))) {
  return { fetchJwks, v: new CfAccessVerifier({ teamDomain: TEAM, audience: AUD }, fetchJwks, () => NOW) };
}

describe("Cloudflare Access verifier (CC-MGMT-08)", () => {
  it("accepts a correctly signed service-token assertion", async () => {
    const { v, fetchJwks } = verifier();
    expect(await v.verify(token(valid))).toEqual({ email: null, commonName: "dots-client-id" });
    expect(fetchJwks).toHaveBeenCalledWith(`${TEAM}/cdn-cgi/access/certs`);
  });

  it("rejects wrong audience, issuer, expiry and signature", async () => {
    const { v } = verifier();
    expect(await v.verify(token({ ...valid, aud: ["b".repeat(64)] }))).toBeNull();
    expect(await v.verify(token({ ...valid, iss: "https://evil.cloudflareaccess.com" }))).toBeNull();
    expect(await v.verify(token({ ...valid, exp: NOW / 1000 - 1 }))).toBeNull();
    const tampered = token(valid).replace(/\.[^.]+$/, ".AAAA");
    expect(await v.verify(tampered)).toBeNull();
    expect(await v.verify(undefined)).toBeNull();
    expect(await v.verify("not-a-jwt")).toBeNull();
  });

  it("treats a JWKS fetch failure as a rejection", async () => {
    const { v } = verifier(vi.fn(async () => { throw new Error("down"); }));
    expect(await v.verify(token(valid))).toBeNull();
  });

  it("parses config only when both values are present and well-formed", () => {
    expect(parseCfAccessConfig(undefined, undefined)).toBeNull();
    expect(parseCfAccessConfig(TEAM, AUD)).toEqual({ teamDomain: TEAM, audience: AUD });
    expect(() => parseCfAccessConfig(TEAM, undefined)).toThrow();
    expect(() => parseCfAccessConfig("http://x.example", AUD)).toThrow();
    expect(() => parseCfAccessConfig(TEAM, "short")).toThrow();
    expect(decodeJwt("a.b")).toBeNull();
  });
});
