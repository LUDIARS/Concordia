import { describe, expect, it } from "vitest";
import { signS3Object } from "./s3-signing.js";

// Deliberately non-credential fixture. Expected digest independently calculated
// with Python stdlib hmac/hashlib/urllib using the SigV4 canonical request.
const example = { bucket: "examplebucket", region: "us-east-1", key: "test.txt", method: "GET" as const,
  credentials: { accessKey: "EXAMPLEACCESSKEY", secretKey: "example-signing-secret-for-tests" },
  now: new Date("2013-05-24T00:00:00Z"), expiresSeconds: 86400 };

describe("AWS object signing", () => {
  it("matches an independently calculated SigV4 query digest", () => {
    const signed = signS3Object(example);
    expect(new URL(signed.url).searchParams.get("X-Amz-Signature"))
      .toBe("529092311ff91d166d7d3e25a87ed3b154951887cbc78b06d9114b55da4ec8d9");
  });
  it("signs overwrite prevention and correctly encodes temporary credentials and paths", () => {
    const signed = signS3Object({ ...example, method: "PUT", key: "job/日本語 !.blend", expiresSeconds: 3600,
      credentials: { ...example.credentials, sessionToken: "a+b/c=" } });
    const url = new URL(signed.url);
    expect(signed.headers).toEqual({ "if-none-match": "*" });
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-none-match");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("a+b/c=");
    expect(url.pathname).toContain("%20%21.blend");
  });
  it.each([{ bucket: "evil.example/path" }, { key: "../x" }, { expiresSeconds: 604801 }])("rejects invalid destinations", patch => {
    expect(() => signS3Object({ ...example, ...patch })).toThrow();
  });
});
