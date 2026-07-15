import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import {
  pickSessionEndInjectText,
  emitAutoSessionEndInject,
  AUTO_SESSION_END_INJECT_SOURCE,
} from "./auto-session-end-inject.js";

function fakeSession(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    provider: "claude-code",
    repo_path: "/r",
    repo_origin: null,
    branch: null,
    host: "h",
    started_at: 0,
    ended_at: null,
    status: "active",
    last_seen_at: 0,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    ...over,
  } as SessionRow;
}

describe("pickSessionEndInjectText", () => {
  it("returns slash command for Claude Code (canonical + short form)", () => {
    expect(pickSessionEndInjectText("claude-code")).toBe("/session-end");
    expect(pickSessionEndInjectText("claude")).toBe("/session-end");
  });

  it("returns the canonical skill invocation for Codex (canonical + short form)", () => {
    expect(pickSessionEndInjectText("codex-cli")).toBe("$session-end");
    expect(pickSessionEndInjectText("codex")).toBe("$session-end");
  });

  it("returns natural language for gemini / unknown", () => {
    expect(pickSessionEndInjectText("gemini-cli")).toBe("session-end してください");
    expect(pickSessionEndInjectText("unknown")).toBe("session-end してください");
    expect(pickSessionEndInjectText("future")).toBe("session-end してください");
  });
});

describe("emitAutoSessionEndInject", () => {
  let received: unknown[] = [];
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    received = [];
    unsub = eventBus.subscribe((ev) => received.push(ev));
  });
  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  it("emits session.inject with the chosen text + standard source for active session", () => {
    const ok = emitAutoSessionEndInject(fakeSession({ id: "s-c", provider: "claude-code" }));
    expect(ok).toBe(true);
    const ev = received.find(
      (e): e is { type: string; target_session_id: string; text: string; source: string } =>
        !!e && typeof e === "object" && (e as Record<string, unknown>).type === "session.inject",
    );
    expect(ev).toBeDefined();
    expect(ev!.target_session_id).toBe("s-c");
    expect(ev!.text).toBe("/session-end");
    expect(ev!.source).toBe(AUTO_SESSION_END_INJECT_SOURCE);
  });

  it("emits the canonical skill invocation for codex-cli", () => {
    emitAutoSessionEndInject(fakeSession({ id: "s-x", provider: "codex-cli" }));
    const ev = received.find(
      (e): e is { type: string; text: string } =>
        !!e && typeof e === "object" && (e as Record<string, unknown>).type === "session.inject",
    );
    expect(ev?.text).toBe("$session-end");
  });

  it("does not emit when session.status is not active", () => {
    const ok = emitAutoSessionEndInject(fakeSession({ status: "ended" }));
    expect(ok).toBe(false);
    const evs = received.filter(
      (e) => !!e && typeof e === "object" && (e as Record<string, unknown>).type === "session.inject",
    );
    expect(evs.length).toBe(0);
  });

  it("does not emit when session.status is lost", () => {
    const ok = emitAutoSessionEndInject(fakeSession({ status: "lost" }));
    expect(ok).toBe(false);
  });
});
