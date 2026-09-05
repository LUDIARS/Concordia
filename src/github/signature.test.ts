import { describe, expect, it } from "vitest";
import { githubSignature, verifyGithubSignature } from "./signature.js";

describe("verifyGithubSignature", () => {
  const body = JSON.stringify({ action: "labeled" });

  it("accepts the signature GitHub would send", () => {
    const secret = "s".repeat(32);
    const verdict = verifyGithubSignature({
      secret,
      header: githubSignature(secret, body),
      body,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("rejects a signature made with another secret", () => {
    const verdict = verifyGithubSignature({
      secret: "right-secret-value",
      header: githubSignature("wrong-secret-value", body),
      body,
    });
    expect(verdict).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a body that differs by one byte", () => {
    const secret = "s".repeat(32);
    const verdict = verifyGithubSignature({
      secret,
      header: githubSignature(secret, body),
      body: `${body} `,
    });
    expect(verdict).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("treats a missing secret as unverifiable, never as verified", () => {
    expect(verifyGithubSignature({ secret: null, header: "sha256=x", body }))
      .toEqual({ ok: false, reason: "secret_unset" });
    expect(verifyGithubSignature({ secret: "   ", header: "sha256=x", body }))
      .toEqual({ ok: false, reason: "secret_unset" });
  });

  it("rejects a request with no signature header", () => {
    expect(verifyGithubSignature({ secret: "s".repeat(32), header: null, body }))
      .toEqual({ ok: false, reason: "signature_missing" });
  });

  it("rejects a shorter header without throwing on the length difference", () => {
    expect(verifyGithubSignature({ secret: "s".repeat(32), header: "sha256=ab", body }))
      .toEqual({ ok: false, reason: "signature_mismatch" });
  });
});
