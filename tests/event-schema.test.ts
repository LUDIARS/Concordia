import { describe, expect, it } from "vitest";
import {
  CONCORDIA_EVENT_TYPES,
  WS_EVENT_VERSION,
  eventFromWsFrame,
  isConcordiaEventType,
  parseWsFrame,
  toWsEventFrame,
} from "../src/shared/event-schema.js";

describe("ws event schema", () => {
  it("adds v1 to outbound events", () => {
    expect(toWsEventFrame({ type: "ping", ts: 2 })).toEqual({
      type: "ping",
      ts: 2,
      v: WS_EVENT_VERSION,
    });
  });

  it("treats missing v as v1 for compatibility", () => {
    const parsed = parseWsFrame({ type: "ping", ts: 1 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.type === "hello") throw new Error("expected event frame");
    expect(parsed.frame.v).toBe(WS_EVENT_VERSION);
    expect(eventFromWsFrame(parsed.frame)).toEqual({ type: "ping", ts: 1 });
  });

  it("rejects unknown event names without throwing", () => {
    const parsed = parseWsFrame({ v: 1, type: "not.real", ts: 1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.reason).toBe("unknown_event");
  });

  it("rejects unsupported versions", () => {
    const parsed = parseWsFrame({ v: 2, type: "ping", ts: 1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.reason).toBe("unsupported_version");
  });

  it("keeps an explicit allowlist of all known event names", () => {
    expect(isConcordiaEventType("chat.posted")).toBe(true);
    expect(isConcordiaEventType("not.real")).toBe(false);
    expect(CONCORDIA_EVENT_TYPES).toContain("delegation.templates_changed");
    expect(CONCORDIA_EVENT_TYPES).toContain("operational.claim.opened");
    expect(CONCORDIA_EVENT_TYPES).toContain("operational.claim.released");
  });
});
