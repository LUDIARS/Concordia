import { describe, expect, it } from "vitest";
import {
  decideInstructionToken,
  INSTRUCTION_INTAKE_TOKEN_SETTING,
  pickPresentedInstructionToken,
  readInstructionIntakeToken,
} from "./instruction-token.js";

const KEY = "s".repeat(48);

describe("instruction intake key (CC-INST-INV-06)", () => {
  it("allows only the exact key and gives a reason otherwise", () => {
    const token = { kind: "set", value: KEY } as const;
    expect(decideInstructionToken(KEY, token)).toEqual({ allowed: true });
    expect(decideInstructionToken(`${KEY}x`, token)).toEqual({ allowed: false, reason: "mismatch" });
    expect(decideInstructionToken("short", token)).toEqual({ allowed: false, reason: "mismatch" });
    expect(decideInstructionToken(undefined, token)).toEqual({ allowed: false, reason: "missing" });
    expect(decideInstructionToken("", token)).toEqual({ allowed: false, reason: "missing" });
  });

  it("closes when the key is unset or unreadable", () => {
    expect(decideInstructionToken(KEY, { kind: "unset" })).toEqual({ allowed: false, reason: "unset" });
    expect(decideInstructionToken(KEY, { kind: "unreadable" })).toEqual({ allowed: false, reason: "unreadable" });
  });

  it("maps the stored setting to a key state", () => {
    expect(readInstructionIntakeToken(() => null)).toEqual({ kind: "unset" });
    expect(readInstructionIntakeToken(() => "")).toEqual({ kind: "unset" });
    expect(readInstructionIntakeToken(() => KEY)).toEqual({ kind: "set", value: KEY });
    expect(readInstructionIntakeToken(() => { throw new Error("decrypt failed"); })).toEqual({ kind: "unreadable" });
  });

  it("picks x-excubitor-token first and falls back to Authorization without altering it", () => {
    const headers = (values: Record<string, string>) => (name: string) => values[name.toLowerCase()];
    expect(pickPresentedInstructionToken(headers({ "x-excubitor-token": ` ${KEY} ` }))).toBe(KEY);
    expect(pickPresentedInstructionToken(headers({ authorization: ` ${KEY} ` }))).toBe(KEY);
    expect(pickPresentedInstructionToken(headers({ "x-excubitor-token": "a", authorization: KEY }))).toBe("a");
    expect(pickPresentedInstructionToken(headers({ authorization: `Bearer ${KEY}` }))).toBe(`Bearer ${KEY}`);
    expect(pickPresentedInstructionToken(headers({}))).toBeUndefined();
    expect(pickPresentedInstructionToken(headers({ authorization: "  " }))).toBeUndefined();
  });

  it("keeps its own setting key apart from the playtest intake key", () => {
    expect(INSTRUCTION_INTAKE_TOKEN_SETTING).toBe("agent_instructions.intake_token");
  });
});
