import { describe, expect, it, vi } from "vitest";
import { readInstructionAccessConfig } from "./access-config.js";
import { createInstructionAccessGate } from "./public-access.js";

const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];

describe("instruction access gate (CC-INST-INV-06 / INV-07)", () => {
  it("treats the public host or any tunnel header as public", () => {
    const gate = createInstructionAccessGate({ publicHost: "cc-home.ai-run-do.com", verifier: null });
    expect(gate.origin(headers({ host: "127.0.0.1:11111" }))).toBe("local");
    expect(gate.origin(headers({ host: "cc-home.ai-run-do.com" }))).toBe("public");
    expect(gate.origin(headers({ host: "127.0.0.1:11111", "cf-ray": "abc" }))).toBe("public");
    expect(gate.origin(headers({ host: "localhost", "cf-connecting-ip": "203.0.113.1" }))).toBe("public");
    expect(gate.origin(headers({ host: "localhost", "cf-access-jwt-assertion": "x" }))).toBe("public");
  });

  it("still catches tunnel requests when no public host is configured", () => {
    const gate = createInstructionAccessGate({ publicHost: null, verifier: null });
    expect(gate.origin(headers({ host: "127.0.0.1:11111" }))).toBe("local");
    expect(gate.origin(headers({ host: "127.0.0.1:11111", "cf-ray": "abc" }))).toBe("public");
  });

  it("rejects public requests when Access is not configured and verifies the assertion otherwise", async () => {
    expect(await createInstructionAccessGate({ publicHost: null, verifier: null }).verifyPublic(headers({ "cf-access-jwt-assertion": "x" }))).toBe(false);
    const verify = vi.fn(async (assertion: string | undefined) => (assertion === "good" ? { commonName: "svc" } : null));
    const gate = createInstructionAccessGate({ publicHost: "cc-home.ai-run-do.com", verifier: { verify } });
    expect(await gate.verifyPublic(headers({ "cf-access-jwt-assertion": "good" }))).toBe(true);
    expect(await gate.verifyPublic(headers({ "cf-access-jwt-assertion": "bad" }))).toBe(false);
    expect(await gate.verifyPublic(headers({}))).toBe(false);
    expect(verify).toHaveBeenLastCalledWith(undefined);
  });
});

describe("instruction access config", () => {
  const TEAM = "https://example.cloudflareaccess.com";
  const AUD = "a".repeat(64);

  it("is disabled (public rejected) when nothing is set", () => {
    expect(readInstructionAccessConfig({})).toEqual({ publicHost: null, access: null, problem: null });
  });

  it("reads host, team and audience", () => {
    expect(readInstructionAccessConfig({
      CONCORDIA_INSTRUCTIONS_PUBLIC_HOST: "CC-Home.ai-run-do.com",
      CONCORDIA_INSTRUCTIONS_CF_ACCESS_TEAM_DOMAIN: TEAM,
      CONCORDIA_INSTRUCTIONS_CF_ACCESS_AUD: AUD,
    })).toEqual({ publicHost: "cc-home.ai-run-do.com", access: { teamDomain: TEAM, audience: AUD }, problem: null });
  });

  it("reports misconfiguration without throwing and keeps Access off", () => {
    const halfSet = readInstructionAccessConfig({ CONCORDIA_INSTRUCTIONS_CF_ACCESS_TEAM_DOMAIN: TEAM });
    expect(halfSet.access).toBeNull();
    expect(halfSet.problem).toEqual(expect.any(String));
    const badHost = readInstructionAccessConfig({ CONCORDIA_INSTRUCTIONS_PUBLIC_HOST: "https://cc-home.ai-run-do.com/" });
    expect(badHost.publicHost).toBeNull();
    expect(badHost.problem).toContain("ホスト名");
  });
});
