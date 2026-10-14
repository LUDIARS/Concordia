import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DriveTransferError } from "./drive-transfer-port.js";
import { createServiceAccountTokenSource, GOOGLE_DRIVE_SCOPE, signServiceAccountAssertion } from "./google-service-account-token.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = {
  clientEmail: "cc@project.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  tokenUri: "https://oauth2.googleapis.com/token",
};

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
}

describe("signServiceAccountAssertion", () => {
  it("signs an RS256 JWT for the Drive scope that the public key verifies", () => {
    const jwt = signServiceAccountAssertion(KEY, GOOGLE_DRIVE_SCOPE, 1_000);
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims!)).toEqual({ iss: KEY.clientEmail, scope: GOOGLE_DRIVE_SCOPE, aud: KEY.tokenUri, iat: 1_000, exp: 4_600 });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);
  });
});

describe("createServiceAccountTokenSource", () => {
  it("exchanges the assertion once and reuses the token until shortly before it expires", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }));
    const source = createServiceAccountTokenSource(KEY, { fetchImpl, now: () => now });
    expect(await source.token()).toBe("tok");
    now = 3_000_000;
    expect(await source.token()).toBe("tok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(KEY.tokenUri);
    expect(String(init.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    now = 3_550_000;
    await source.token();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("raises a code without the response body when Google refuses", async () => {
    const source = createServiceAccountTokenSource(KEY, {
      fetchImpl: async () => new Response("invalid_grant secret detail", { status: 400 }),
    });
    const error = await source.token().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveTransferError);
    expect((error as DriveTransferError).code).toBe("unauthorized");
    expect((error as Error).message).not.toContain("secret");
  });

  it("treats a broken private key as unauthorized", async () => {
    const source = createServiceAccountTokenSource({ ...KEY, privateKey: "not a pem encoded key" }, {
      fetchImpl: vi.fn(),
    });
    await expect(source.token()).rejects.toMatchObject({ code: "unauthorized" });
  });
});
