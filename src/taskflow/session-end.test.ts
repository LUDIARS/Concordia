import { describe, expect, it, vi } from "vitest";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import { finishAutonomousTaskflow } from "./session-end.js";

function session(provider: SessionRow["provider"], goalAndGoEnabled = true): SessionRow {
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
    current_task: "task-one",
    transcript_path: null,
    metadata: JSON.stringify({ goal_and_go: { enabled: goalAndGoEnabled, continuation_count: 0 } }),
    ws_clients: 1,
    target_project: null,
  };
}

function mergeMetadata(row: SessionRow) {
  return vi.fn((_id: string, patch: Record<string, unknown>) => {
    row.metadata = JSON.stringify({ ...JSON.parse(row.metadata ?? "{}") as Record<string, unknown>, ...patch });
  });
}

describe("finishAutonomousTaskflow", () => {
  it.each([
    ["claude-code"],
    ["codex-cli"],
  ] as const)("schedules provider-aware teardown exactly once for %s", (provider) => {
    const row = session(provider);
    const events: Array<{ kind: string; payload: string }> = [];
    const sessions = {
      findSession: vi.fn(() => row),
      appendEvent: vi.fn((input) => events.push({ kind: input.kind, payload: JSON.stringify(input.payload) })),
      mergeMetadata: mergeMetadata(row),
    };
    const emitted: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === row.id) emitted.push(event.text);
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

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(provider === "claude-code" ? "/session-end" : "$session-end");
    expect(sessions.appendEvent).toHaveBeenCalledOnce();
    expect(JSON.parse(row.metadata ?? "{}")).toMatchObject({
      teardown_ladder: { run_key: "task-one:0", retries_sent: 0 },
    });
    unsubscribe();
  });

  it("schedules teardown even when goal-and-go is explicitly disabled", () => {
    const row = session("codex-cli", false);
    const sessions = {
      findSession: vi.fn(() => row),
      appendEvent: vi.fn(),
      mergeMetadata: mergeMetadata(row),
    };
    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome: "open",
      residualOutcome: "none",
    })).toBe(true);
  });

  it("allows another teardown schedule after the task/run boundary changes", () => {
    const row = session("codex-cli");
    const events: Array<{ kind: string; payload: string }> = [];
    const sessions = {
      findSession: vi.fn(() => row),
      appendEvent: vi.fn((input) => events.push({ kind: input.kind, payload: JSON.stringify(input.payload) })),
      mergeMetadata: mergeMetadata(row),
    };
    expect(finishAutonomousTaskflow({
      sessionId: row.id, sessions: sessions as any, goalOutcome: "open", residualOutcome: "none",
    })).toBe(true);
    row.current_task = "task-two";
    expect(finishAutonomousTaskflow({
      sessionId: row.id, sessions: sessions as any, goalOutcome: "open", residualOutcome: "none",
    })).toBe(true);
  });

  it("uses a stable delegation run key when consecutive runs have the same task title", () => {
    const row = session("codex-cli");
    const sessions = {
      findSession: vi.fn(() => row),
      appendEvent: vi.fn(),
      mergeMetadata: mergeMetadata(row),
    };
    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome: "open",
      residualOutcome: "none",
      runKey: "delegation:run-1",
    })).toBe(true);
    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome: "open",
      residualOutcome: "none",
      runKey: "delegation:run-2",
    })).toBe(true);
    expect(JSON.parse(row.metadata ?? "{}")).toMatchObject({
      teardown_ladder: { run_key: "delegation:run-2" },
    });
  });

  it("未回答の質問がある間は終了 ladder を予約せず、回答後に予約する", () => {
    const row = session("claude-code");
    const events: Array<{ kind: string; payload: string }> = [];
    const sessions = {
      findSession: vi.fn(() => row),
      appendEvent: vi.fn((input) => events.push({ kind: input.kind, payload: JSON.stringify(input.payload) })),
      mergeMetadata: mergeMetadata(row),
    };
    const emitted: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.target_session_id === row.id) emitted.push(event.text);
    });

    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome: "open",
      residualOutcome: "none",
      hasPendingQuestion: () => true,
    })).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(sessions.appendEvent).not.toHaveBeenCalled();

    // 回答が付けば、次の周回で本来どおり送られる (記録を残していないので抑止されない)。
    expect(finishAutonomousTaskflow({
      sessionId: row.id,
      sessions: sessions as any,
      goalOutcome: "open",
      residualOutcome: "none",
      hasPendingQuestion: () => false,
    })).toBe(true);
    expect(emitted).toHaveLength(1);
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
      appendEvent: vi.fn(),
      mergeMetadata: mergeMetadata(row),
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
