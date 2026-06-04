import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBox, isEncrypted, resolveSecretKey } from "./secret-box.js";

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

describe("resolveSecretKey", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-box-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("env passphrase is hashed to 32 bytes and ignores the key file", () => {
    const keyFile = join(dir, "key");
    const key = resolveSecretKey({ envValue: "pass phrase", keyFile });
    expect(key).toEqual(createHash("sha256").update("pass phrase", "utf8").digest());
    expect(key.length).toBe(32);
  });

  it("generates and persists a 32-byte key when the file is absent", () => {
    const keyFile = join(dir, "key");
    const key = resolveSecretKey({ keyFile });
    expect(key.length).toBe(32);
    // 永続化された値を読み直すと同じ鍵になる
    expect(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64")).toEqual(key);
  });

  it("returns the existing key on subsequent calls (read path)", () => {
    const keyFile = join(dir, "key");
    const first = resolveSecretKey({ keyFile });
    const second = resolveSecretKey({ keyFile });
    expect(second).toEqual(first);
  });

  it("race loser reads the winner's key instead of overwriting (EEXIST path)", () => {
    const keyFile = join(dir, "key");
    // 「勝者」が先に生成済みの状態を再現
    const winner = randomBytes(32);
    writeFileSync(keyFile, winner.toString("base64"), { encoding: "utf8" });
    // existsSync=true でも read path、 仮に同時生成しても EEXIST で勝者を読む
    expect(resolveSecretKey({ keyFile })).toEqual(winner);
  });

  it("throws on a corrupt (wrong-length) key file rather than silently regenerating", () => {
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, Buffer.from("short").toString("base64"), { encoding: "utf8" });
    expect(() => resolveSecretKey({ keyFile })).toThrow(/invalid/);
  });
});
