import { describe, expect, it } from "vitest";
import { resolveSubsidiaryBotToken } from "./service-deployed-runtime.js";

describe("resolveSubsidiaryBotToken", () => {
  it("prefers the subsidiary's own bot token when set", () => {
    expect(resolveSubsidiaryBotToken({ encryptedToken: "enc", decrypt: () => "sub-token", hqToken: () => "hq-token" })).toBe("sub-token");
  });

  it("falls back to the HQ bot token when the subsidiary token is unset", () => {
    expect(resolveSubsidiaryBotToken({ encryptedToken: null, decrypt: () => "unused", hqToken: () => "hq-token" })).toBe("hq-token");
  });

  it("falls back to the HQ bot token when the subsidiary token cannot be decrypted", () => {
    expect(resolveSubsidiaryBotToken({ encryptedToken: "broken", decrypt: () => { throw new Error("bad"); }, hqToken: () => "hq-token" })).toBe("hq-token");
  });

  it("returns null when neither token is available", () => {
    expect(resolveSubsidiaryBotToken({ encryptedToken: null, decrypt: () => "unused" })).toBeNull();
    expect(resolveSubsidiaryBotToken({ encryptedToken: null, decrypt: () => "unused", hqToken: () => null })).toBeNull();
  });
});
