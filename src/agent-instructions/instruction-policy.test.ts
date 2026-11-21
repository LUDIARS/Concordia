import { describe, expect, it } from "vitest";
import {
  ACK_REDELIVERY_MS,
  INSTRUCTION_ID_PATTERN,
  canonicalJson,
  decideAck,
  decideResult,
  isoSeconds,
  newInstructionId,
  redeliveryCutoff,
  retentionCutoff,
  storedSummary,
} from "./instruction-policy.js";

describe("instruction policy (spec/feature/agent-instructions-bridge.md)", () => {
  it("builds ids as inst:<agent>:<UTC>:<hex>", () => {
    const id = newInstructionId("muse", new Date("2026-11-21T00:00:00.789Z"), () => "a1b2c3");
    expect(id).toBe("inst:muse:20261121T000000Z:a1b2c3");
    expect(INSTRUCTION_ID_PATTERN.test(id)).toBe(true);
    expect(INSTRUCTION_ID_PATTERN.test(newInstructionId("muse", new Date()))).toBe(true);
    expect(INSTRUCTION_ID_PATTERN.test("inst:muse:20261121T000000Z:../x")).toBe(false);
  });

  it("formats timestamps as second-precision ISO 8601 UTC", () => {
    expect(isoSeconds(new Date("2026-11-21T01:02:03.456Z"))).toBe("2026-11-21T01:02:03Z");
  });

  it("CC-INST-INV-03: ack accepts pending, repeats acked as duplicate, rejects finished", () => {
    expect(decideAck("pending")).toBe("accept");
    expect(decideAck("acked")).toBe("duplicate");
    expect(decideAck("done")).toBe("conflict");
    expect(decideAck("failed")).toBe("conflict");
  });

  it("CC-INST-INV-04: result accepts open states, treats the identical result as duplicate and any other as conflict", () => {
    const incoming = { status: "done" as const, summary: "ok", detail: canonicalJson({ b: 1, a: 2 }) };
    expect(decideResult({ status: "pending", resultSummary: null, resultDetail: null }, incoming)).toBe("accept");
    expect(decideResult({ status: "acked", resultSummary: null, resultDetail: null }, incoming)).toBe("accept");
    const stored = { status: "done" as const, resultSummary: "ok", resultDetail: canonicalJson({ a: 2, b: 1 }) };
    expect(decideResult(stored, incoming)).toBe("duplicate");
    expect(decideResult(stored, { ...incoming, status: "failed" })).toBe("conflict");
    expect(decideResult(stored, { ...incoming, summary: "other" })).toBe("conflict");
    expect(decideResult(stored, { ...incoming, detail: null })).toBe("conflict");
  });

  it("canonicalizes JSON independent of key order", () => {
    expect(canonicalJson({ z: [1, { y: 1, x: 2 }], a: null })).toBe('{"a":null,"z":[1,{"x":2,"y":1}]}');
  });

  it("truncates stored summaries to 2000 characters", () => {
    expect(Array.from(storedSummary("あ".repeat(2500)))).toHaveLength(2000);
    expect(storedSummary("short")).toBe("short");
  });

  it("computes the 30 minute redelivery and 90 day retention cutoffs", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    expect(ACK_REDELIVERY_MS).toBe(30 * 60 * 1000);
    expect(redeliveryCutoff(now)).toBe("2026-11-21T11:30:00Z");
    expect(retentionCutoff(now)).toBe("2026-08-23T12:00:00Z");
  });
});
