import { describe, expect, it } from "vitest";
import { parseAck, parsePollQuery, parseRegister, parseResult } from "./instruction-requests.js";

const register = { agent: "muse", type: "run_task", title: "件名", body: "本文", params: { k: 1 } };

describe("instruction requests (CC-INST-INV-01)", () => {
  it("accepts the fixed register schema and defaults params to {}", () => {
    expect(parseRegister(register)).toEqual({ ok: true, value: register });
    const { params: _params, ...withoutParams } = register;
    expect(parseRegister(withoutParams)).toEqual({ ok: true, value: { ...withoutParams, params: {} } });
  });

  it("rejects unknown fields with a fix hint", () => {
    const parsed = parseRegister({ ...register, priority: "high" });
    expect(parsed).toEqual({ ok: false, error: { code: "unknown_field", message: expect.stringContaining("priority") } });
  });

  it("rejects types outside the allowlist", () => {
    const parsed = parseRegister({ ...register, type: "delete_files" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("unsupported_type");
      expect(parsed.error.message).toContain("notify_only / run_task / status_query");
    }
  });

  it("rejects wrong agents, wrong types, missing fields and over-limit sizes", () => {
    expect(parseRegister({ ...register, agent: "other" }).ok).toBe(false);
    expect(parseRegister({ ...register, title: 1 }).ok).toBe(false);
    expect(parseRegister({ ...register, title: "x".repeat(201) }).ok).toBe(false);
    expect(parseRegister({ ...register, body: "x".repeat(4001) }).ok).toBe(false);
    expect(parseRegister({ ...register, params: { blob: "x".repeat(8000) } }).ok).toBe(false);
    expect(parseRegister({ ...register, params: [1] }).ok).toBe(false);
    const missing = parseRegister({ agent: "muse", type: "run_task", title: "t" });
    expect(missing).toEqual({ ok: false, error: { code: "missing_field", message: "body は必須です" } });
    expect(parseRegister(null)).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid_body" }) });
  });

  it("accepts only {agent} for ack", () => {
    expect(parseAck({ agent: "muse" })).toEqual({ ok: true, value: { agent: "muse" } });
    expect(parseAck({ agent: "muse", extra: true }).ok).toBe(false);
    expect(parseAck({}).ok).toBe(false);
  });

  it("accepts done / failed results with optional detail and enforces limits", () => {
    expect(parseResult({ agent: "muse", status: "done", summary: "ok" })).toEqual({ ok: true, value: { agent: "muse", status: "done", summary: "ok" } });
    expect(parseResult({ agent: "muse", status: "failed", summary: "ng", detail: { reason: "x" } }).ok).toBe(true);
    expect(parseResult({ agent: "muse", status: "acked", summary: "ok" }).ok).toBe(false);
    expect(parseResult({ agent: "muse", status: "done", summary: "x".repeat(401) }).ok).toBe(false);
    expect(parseResult({ agent: "muse", status: "done", summary: "ok", detail: { blob: "x".repeat(16000) } }).ok).toBe(false);
    expect(parseResult({ agent: "muse", status: "done", summary: "ok", note: "" }).ok).toBe(false);
  });

  it("parses poll queries: agent required, status defaults to pending, limit 1..20", () => {
    const q = (values: Record<string, string>) => (name: string) => values[name];
    expect(parsePollQuery(q({ agent: "muse" }))).toEqual({ ok: true, value: { agent: "muse", status: "pending", limit: 10 } });
    expect(parsePollQuery(q({ agent: "muse", status: "acked", limit: "20" }))).toEqual({ ok: true, value: { agent: "muse", status: "acked", limit: 20 } });
    expect(parsePollQuery(q({})).ok).toBe(false);
    expect(parsePollQuery(q({ agent: "other" })).ok).toBe(false);
    expect(parsePollQuery(q({ agent: "muse", status: "lost" })).ok).toBe(false);
    for (const limit of ["0", "21", "-1", "1.5", "abc", ""]) expect(parsePollQuery(q({ agent: "muse", limit })).ok).toBe(false);
  });
});
