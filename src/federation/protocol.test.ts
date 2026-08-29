import { describe, expect, it } from "vitest";
import {
  FEDERATION_PROTOCOL_VERSION,
  parseFederationFrame,
  serializeFederationFrame,
} from "./protocol.js";

describe("federation protocol", () => {
  it("round-trips every frame type", () => {
    const frames = [
      { type: "hello", site_id: "site-a", token: "t", site_version: "1.0.0", platform: "darwin" },
      { type: "welcome", hq_version: "1.0.0", pending_events: 3 },
      { type: "event", seq: 7, payload: { kind: "noop" } },
      { type: "ingress", guild_id: "g1", channel_id: "c1", message_id: "m1", author_id: "u1", author_label: "User", text: "hello", ts: 1 },
      { type: "egress-request", request_id: "r1", guild_id: "g1", channel_id: "c1", text: "hello" },
      { type: "egress-result", request_id: "r1", ok: true },
      { type: "ack", seq: 7 },
      { type: "error", code: "auth_failed", message: "nope" },
    ] as const;
    for (const frame of frames) {
      const parsed = parseFederationFrame(serializeFederationFrame(frame));
      expect(parsed.ok, frame.type).toBe(true);
      if (parsed.ok) expect(parsed.frame.type).toBe(frame.type);
    }
  });

  it("rejects unsupported protocol versions", () => {
    const raw = JSON.stringify({ v: FEDERATION_PROTOCOL_VERSION + 1, type: "ack", seq: 1 });
    const parsed = parseFederationFrame(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("unsupported_version");
  });

  it("rejects non-JSON, unknown types, and schema violations", () => {
    expect(parseFederationFrame("not json").ok).toBe(false);
    const unknown = parseFederationFrame(JSON.stringify({ v: 1, type: "steal-token" }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("unknown_type");
    const badSite = parseFederationFrame(
      JSON.stringify({ v: 1, type: "hello", site_id: "UPPER CASE", token: "t" }),
    );
    expect(badSite.ok).toBe(false);
  });

  it("rejects Object.prototype keys as frame types without throwing", () => {
    // 素の object literal を type で引くと Object.prototype 由来の値が truthy で
    // 返る。未認証の相手が例外を起こせないよう unknown_type で弾くこと。
    for (const type of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const parsed = parseFederationFrame(JSON.stringify({ v: 1, type }));
      expect(parsed.ok, type).toBe(false);
      if (!parsed.ok) expect(parsed.reason, type).toBe("unknown_type");
    }
  });
});
