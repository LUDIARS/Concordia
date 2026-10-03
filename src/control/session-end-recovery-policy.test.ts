import { describe, expect, it } from "vitest";
import { hasSessionEndRecoveryExpired, isSameSessionEndRecoveryRequest } from "./session-end-recovery-policy.js";

const row = (age: number, clients = 1) => ({
  status: "ended", ws_clients: clients,
  metadata: JSON.stringify({ session_end_pending_at: 10000 - age, lictor_pid: 123,
    concordia_spawn_id: "spawn-instance-1234", start_iso: "2026-10-04T00:00:00Z" }),
});

describe("session-end recovery policy", () => {
  it("preserves the disconnected grace and bounds connected save time", () => {
    expect(hasSessionEndRecoveryExpired(row(301, 0), 10000, 300)).toBe(true);
    expect(hasSessionEndRecoveryExpired(row(1800), 10000, 300)).toBe(false);
    expect(hasSessionEndRecoveryExpired(row(1801), 10000, 300)).toBe(true);
    expect(hasSessionEndRecoveryExpired(row(1801), 10000, 3600)).toBe(false);
  });
  it("never interprets invalid timing as a destructive deadline", () => {
    for (const grace of [NaN, Infinity, -1]) expect(hasSessionEndRecoveryExpired(row(9999), 10000, grace)).toBe(false);
    expect(hasSessionEndRecoveryExpired({ ...row(9999), metadata: "bad" }, 10000, 300)).toBe(false);
    expect(hasSessionEndRecoveryExpired({ ...row(9999), status: "active" }, 10000, 300)).toBe(false);
  });
  it("requires the same pending request and process generation, ignoring unrelated updates", () => {
    const original = row(2000);
    const metadata = JSON.parse(original.metadata);
    expect(isSameSessionEndRecoveryRequest(original, { ...original, metadata: JSON.stringify({ ...metadata, cost: 10 }) })).toBe(true);
    for (const patch of [{session_end_pending_at:null}, {session_end_pending_at:9000}, {lictor_pid:124},
      {concordia_spawn_id:"spawn-instance-4321"}, {start_iso:"2026-10-04T00:01:00Z"}]) {
      expect(isSameSessionEndRecoveryRequest(original, { ...original, metadata: JSON.stringify({ ...metadata, ...patch }) })).toBe(false);
    }
    expect(isSameSessionEndRecoveryRequest(original, { ...original, status: "active" })).toBe(false);
  });
});
