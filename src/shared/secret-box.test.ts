import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { SecretBox, isEncrypted } from "./secret-box.js";

describe("SecretBox", () => {
  it("round-trips a value and the ciphertext does not contain the plaintext", () => {
    const box = new SecretBox(randomBytes(32));
    const enc = box.encrypt("xoxb-super-secret");
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain("xoxb-super-secret");
    expect(box.decrypt(enc)).toBe("xoxb-super-secret");
  });

  it("fails to decrypt with a different key", () => {
    const a = new SecretBox(randomBytes(32));
    const b = new SecretBox(randomBytes(32));
    expect(() => b.decrypt(a.encrypt("hello"))).toThrow();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow();
  });

  it("isEncrypted is false for plaintext / null", () => {
    expect(isEncrypted("plain")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });
});
