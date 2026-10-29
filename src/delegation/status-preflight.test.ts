import { describe, expect, it } from "vitest";
import { preflightStatusJson } from "./status-preflight.js";
import { StatusSchema } from "./status-schema.js";

const inspect = (value: unknown) => preflightStatusJson(JSON.stringify(value));

describe("status input preflight", () => {
  it.each(["running", "completed", "failed"])("accepts %s without asserting evidence", status => {
    expect(inspect({ status })).toEqual({ valid: true, issues: [] });
  });
  it.each(["detail", "result"])("retains the UTF-16 limit for %s", field => {
    for (const text of ["a".repeat(4000), "日".repeat(4000), "😀".repeat(2000)]) {
      expect(inspect({ status: "completed", [field]: text }).valid).toBe(true);
      expect(inspect({ status: "completed", [field]: `${text}日` })).toEqual({ valid: false,
        issues: [{ field: `$.${field}`, code: "too_big", limit: 4000, length: 4001 }] });
    }
    expect(inspect({ status: "failed", [field]: "😀".repeat(2001) }).issues[0].length).toBe(4002);
  });
  it("keeps nested bounds and remaining rules identical to the API schema", () => {
    const values = [
      { status: "partial" }, { status: "partial", remaining: [] },
      { status: "partial", remaining: [{ title: "承認", kind: "wait" }] },
      { status: "completed", remaining: [{ title: "未完了" }] },
      { status: "running", remaining: [{ title: "a", note: "x".repeat(4001) }] },
      { status: "failed", acceptance_report: [{ criterion: "C-20", met: false, note: "x".repeat(4001) }] },
      { status: "failed", sidecar_return: { summary: "x".repeat(4001) } },
      { status: "running", remaining: Array.from({ length: 101 }, () => ({ title: "x" })) },
      { status: "failed", acceptance_report: Array.from({ length: 201 }, () => ({ criterion: "x", met: true })) },
    ];
    for (const value of values) expect(inspect(value).valid).toBe(StatusSchema.safeParse(value).success);
    expect(inspect(values[4]).issues[0]).toEqual({ field: "$.remaining[0].note", code: "too_big", limit: 4000, length: 4001 });
  });
  it("does not repeat secrets from parser, enum, type or unknown property errors", () => {
    const marker = "non-sensitive-test-marker";
    const inputs = [`{"status":"${marker}",`, JSON.stringify({ status: marker }),
      JSON.stringify({ status: "failed", detail: { [marker]: marker } }),
      JSON.stringify({ status: "partial", remaining: [{ title: marker, kind: marker }] }),
      JSON.stringify({ status: "failed", [marker]: marker, detail: marker.repeat(1000) })];
    for (const input of inputs) {
      const report = preflightStatusJson(input);
      expect(report.valid).toBe(false);
      expect(JSON.stringify(report)).not.toContain(marker);
      expect(JSON.stringify(report)).not.toContain("message");
    }
  });
  it.each(["", "{", "null", "[]", "42", '"secret"'])("rejects invalid JSON or shape: %s", input => {
    expect(preflightStatusJson(input).valid).toBe(false);
  });
  it("preserves existing unknown-key stripping and optional kind compatibility", () => {
    expect(inspect({ status: "partial", remaining: [{ title: "x" }], unknown: "secret" }).valid).toBe(true);
  });
});
