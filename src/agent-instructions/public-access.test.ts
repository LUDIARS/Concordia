import { describe, expect, it } from "vitest";
import { readInstructionAccessConfig } from "./access-config.js";
import type { InstructionIntakeToken } from "./instruction-token.js";
import { createInstructionAccessGate } from "./public-access.js";

const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];
const KEY = "z".repeat(32);
const withKey = (token: InstructionIntakeToken = { kind: "set", value: KEY }) => () => token;

describe("instruction access gate (CC-INST-INV-06 / INV-07)", () => {
  it("treats the public host or any tunnel header as public", () => {
    const gate = createInstructionAccessGate({ publicHost: "cc-home.ai-run-do.com", readToken: withKey() });
    expect(gate.origin(headers({ host: "127.0.0.1:11111" }))).toBe("local");
    expect(gate.origin(headers({ host: "cc-home.ai-run-do.com" }))).toBe("public");
    expect(gate.origin(headers({ host: "127.0.0.1:11111", "cf-ray": "abc" }))).toBe("public");
    expect(gate.origin(headers({ host: "localhost", "cf-connecting-ip": "203.0.113.1" }))).toBe("public");
    expect(gate.origin(headers({ host: "localhost", "cf-access-jwt-assertion": "x" }))).toBe("public");
  });

  it("still catches tunnel requests when no public host is configured", () => {
    const gate = createInstructionAccessGate({ publicHost: null, readToken: withKey() });
    expect(gate.origin(headers({ host: "127.0.0.1:11111" }))).toBe("local");
    expect(gate.origin(headers({ host: "127.0.0.1:11111", "cf-ray": "abc" }))).toBe("public");
  });

  it("authorizes public requests only with the x-excubitor-token intake key", () => {
    const gate = createInstructionAccessGate({ publicHost: null, readToken: withKey() });
    expect(gate.authorizePublic(headers({ "x-excubitor-token": KEY }))).toEqual({ allowed: true });
    expect(gate.authorizePublic(headers({ "x-excubitor-token": ` ${KEY} ` }))).toEqual({ allowed: true });
    expect(gate.authorizePublic(headers({ "x-excubitor-token": "other" }))).toEqual({ allowed: false, reason: "mismatch" });
    expect(gate.authorizePublic(headers({ "cf-access-jwt-assertion": "a.b.c" }))).toEqual({ allowed: false, reason: "missing" });
    expect(createInstructionAccessGate({ publicHost: null, readToken: withKey({ kind: "unset" }) })
      .authorizePublic(headers({ "x-excubitor-token": KEY }))).toEqual({ allowed: false, reason: "unset" });
  });

  it("accepts the same key through Authorization when x-excubitor-token is absent", () => {
    const json = '{"cf-access-client-id":"id.access","cf-access-client-secret":"0123456789abcdef0123456789abcdef"}';
    const gate = createInstructionAccessGate({ publicHost: null, readToken: withKey({ kind: "set", value: json }) });
    expect(gate.authorizePublic(headers({ authorization: json }))).toEqual({ allowed: true });
    expect(gate.authorizePublic(headers({ authorization: `Bearer ${json}` }))).toEqual({ allowed: false, reason: "mismatch" });
    expect(gate.authorizePublic(headers({ authorization: "other" }))).toEqual({ allowed: false, reason: "mismatch" });
    // x-excubitor-token があればそれだけで判定する (Authorization が一致していても通さない)。
    expect(gate.authorizePublic(headers({ "x-excubitor-token": "other", authorization: json }))).toEqual({ allowed: false, reason: "mismatch" });
    expect(gate.authorizePublic(headers({ "x-excubitor-token": json, authorization: "other" }))).toEqual({ allowed: true });
    expect(gate.authorizePublic(headers({}))).toEqual({ allowed: false, reason: "missing" });
    expect(createInstructionAccessGate({ publicHost: null, readToken: withKey({ kind: "unset" }) })
      .authorizePublic(headers({ authorization: json }))).toEqual({ allowed: false, reason: "unset" });
  });
});

describe("instruction access config", () => {
  it("has no public host when nothing is set", () => {
    expect(readInstructionAccessConfig({})).toEqual({ publicHost: null, problem: null });
  });

  it("reads and normalizes the host", () => {
    expect(readInstructionAccessConfig({ CONCORDIA_INSTRUCTIONS_PUBLIC_HOST: "CC-Home.ai-run-do.com" }))
      .toEqual({ publicHost: "cc-home.ai-run-do.com", problem: null });
  });

  it("reports a malformed host without throwing", () => {
    const badHost = readInstructionAccessConfig({ CONCORDIA_INSTRUCTIONS_PUBLIC_HOST: "https://cc-home.ai-run-do.com/" });
    expect(badHost.publicHost).toBeNull();
    expect(badHost.problem).toContain("ホスト名");
  });
});
