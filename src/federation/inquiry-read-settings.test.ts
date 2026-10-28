import { describe, expect, it } from "vitest";
import { inquiryReadSettings } from "./inquiry-read-settings.js";

describe("inquiryReadSettings", () => {
  it("installs an all-tool hook with the trusted root encoded as data", async () => {
    const root = "C:/workspace/project & name";
    const settings = JSON.parse(await inquiryReadSettings(root));
    const rule = settings.hooks.PreToolUse[0];
    expect(rule.matcher).toBe(".*");
    expect(rule.hooks[0].command).toContain("federation-inquiry-read-guard.mjs");
    expect(rule.hooks[0].command).not.toContain(root);
    expect(rule.hooks[0].command).toContain(Buffer.from(root, "utf8").toString("base64url"));
  });
});
