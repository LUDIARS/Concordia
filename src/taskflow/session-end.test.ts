import { describe, expect, it, vi } from "vitest";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import { finishAutonomousTaskflow } from "./session-end.js";

function session(provider: SessionRow["provider"]): SessionRow {
  return {
    id: `session-${provider}`,
    provider,
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/task",
    host: "host",
    started_at: 1,
    ended_at: null,
    status: "active",
    last_seen_at: 1,
    current_task: null,
    transcript_path: null,
    metadata: JSON.stringify({ goal_and_go: { enabled: true } }),
    ws_clients: 1,
    target_project: null,
  };
}

describe("finishAutonomousTaskflow", () => {
  it.each([
    ["claude-code", "/session-end"],
    ["codex-cli", "$session-end"],
  ] as const)("injects the provider-aware command exactly once for %s", (provider, expected) => {
    const row = session(provider);
    const events: Array<{ kind: string; payload: string }> = [];
    const sessions = {
      findSession: vi.fn(() => row),
      recentEvents: vi.fn(() => events),
      appendEvent: vi.fn((input) => events.push({ kind: input.kind, payload: JSON.stringify(input.payload) })),
    };
    const emitted: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject") emitted.push(event.text);
    });

    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome: "open",
      residualOutcome: "none",
    })).toBe(true);
    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome: "open",
      residualOutcome: "none",
    })).toBe(false);

    expect(emitted).toEqual([expected]);
    expect(sessions.appendEvent).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it.each([
    ["next-task", "open"],
    ["decompose", "open"],
    ["none", "merged"],
    ["none", "missing"],
  ] as const)("does not end while residual or human-gated work remains (%s/%s)", (residualOutcome, goalOutcome) => {
    const row = session("codex-cli");
    const sessions = {
      findSession: vi.fn(() => row),
      recentEvents: vi.fn(() => []),
      appendEvent: vi.fn(),
    };
    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome,
      residualOutcome,
    })).toBe(false);
    expect(sessions.appendEvent).not.toHaveBeenCalled();
  });
});
