import { afterEach, describe, expect, it, vi } from "vitest";
import { eventBus } from "../events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionEventRow } from "../shared/types.js";
import {
  buildIdleNudgeText,
  collectIdleNudgeRequesters,
  createIdleNudge,
  shouldArmIdleNudgeFromFrame,
  shouldClearIdleNudgeFromFrame,
  startIdleNudge,
  type IdleNudgeTimerApi,
  type IdleNudgeTimerHandle,
} from "./idle-nudge.js";

interface FakeHandle extends IdleNudgeTimerHandle {
  id: number;
  unrefCalled: boolean;
}

class FakeTimers implements IdleNudgeTimerApi<FakeHandle> {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void; handle: FakeHandle }>();
  now = 0;

  setTimeout(callback: () => void, ms: number): FakeHandle {
    const handle: FakeHandle = {
      id: this.nextId++,
      unrefCalled: false,
      unref() {
        handle.unrefCalled = true;
      },
    };
    this.timers.set(handle.id, { at: this.now + ms, callback, handle });
    return handle;
  }

  clearTimeout(handle: FakeHandle): void {
    this.timers.delete(handle.id);
  }

  advance(ms: number): void {
    this.now += ms;
    const due = Array.from(this.timers.entries())
      .filter(([, timer]) => timer.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

function ev(kind: string, payload: object, ts = 0): SessionEventRow {
  return { id: ts, session_id: "s", ts, kind, payload: JSON.stringify(payload) };
}

function activeRepo(events: SessionEventRow[] = []): SessionsRepo {
  return {
    findSession: () => ({ status: "active" }),
    recentEvents: () => events,
    eventsByKind: () => events,
  } as unknown as SessionsRepo;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createIdleNudge", () => {
  it("fires notify once after the configured delay", () => {
    const timers = new FakeTimers();
    const notified: string[] = [];
    const idle = createIdleNudge({
      seconds: 2,
      timers,
      notify: (sessionId) => {
        notified.push(sessionId);
      },
    });

    idle.arm("s1");
    expect(timers.pendingCount()).toBe(1);
    timers.advance(1_999);
    expect(notified).toEqual([]);
    timers.advance(1);
    expect(notified).toEqual(["s1"]);
    expect(timers.pendingCount()).toBe(0);
    timers.advance(2_000);
    expect(notified).toEqual(["s1"]);
  });

  it("clear prevents notification and re-arm resets the deadline", () => {
    const timers = new FakeTimers();
    const notified: string[] = [];
    const idle = createIdleNudge({
      seconds: 1,
      timers,
      notify: (sessionId) => {
        notified.push(sessionId);
      },
    });

    idle.arm("s1");
    timers.advance(500);
    idle.arm("s1");
    timers.advance(999);
    expect(notified).toEqual([]);
    timers.advance(1);
    expect(notified).toEqual(["s1"]);

    idle.arm("s2");
    idle.clear("s2");
    timers.advance(1_000);
    expect(notified).toEqual(["s1"]);
  });

  it("does not arm when seconds is disabled", () => {
    const timers = new FakeTimers();
    const idle = createIdleNudge({
      seconds: 0,
      timers,
      notify: () => {
        throw new Error("should not fire");
      },
    });
    idle.arm("s1");
    expect(timers.pendingCount()).toBe(0);
  });
});

describe("idle nudge requester text", () => {
  it("collects distinct human inject requesters only", () => {
    const requesters = collectIdleNudgeRequesters([
      ev("inject", { source: "discord:111:c:m" }, 40),
      ev("inject", { source: "discord:111:c:other" }, 30),
      ev("inject", { source: "slack:U2:C1:1700" }, 20),
      ev("inject", { source: "initial-work" }, 10),
      { id: 1, session_id: "s", ts: 1, kind: "inject", payload: "{broken" },
      ev("prompt", { source: "discord:333:c:m" }, 0),
    ]);

    expect(requesters).toEqual([
      { platform: "discord", userId: "111" },
      { platform: "slack", userId: "U2" },
    ]);
  });

  it("builds a single mention message with the configured seconds", () => {
    expect(buildIdleNudgeText([
      { platform: "discord", userId: "111" },
      { platform: "slack", userId: "U2" },
    ], 120)).toBe(
      "<@111> <@U2> This session has been waiting for input for 120 seconds after its last answer. Still waiting.",
    );
  });
});

describe("idle nudge event predicates", () => {
  it("arms on summary and final assistant frames", () => {
    expect(shouldArmIdleNudgeFromFrame({
      type: "transcript.frame",
      target_session_id: "s",
      seq: 1,
      kind: "summary",
      payload: {},
      ts: 1,
    })).toBe(true);
    expect(shouldArmIdleNudgeFromFrame({
      type: "transcript.frame",
      target_session_id: "s",
      seq: 2,
      kind: "text",
      payload: { role: "assistant", phase: "final_answer" },
      ts: 1,
    })).toBe(true);
    expect(shouldArmIdleNudgeFromFrame({
      type: "transcript.frame",
      target_session_id: "s",
      seq: 3,
      kind: "text",
      payload: { role: "assistant", phase: "commentary" },
      ts: 1,
    })).toBe(false);
  });

  it("clears on user transcript frames", () => {
    expect(shouldClearIdleNudgeFromFrame({
      type: "transcript.frame",
      target_session_id: "s",
      seq: 1,
      kind: "text",
      payload: { role: "user" },
      ts: 1,
    })).toBe(true);
  });
});

describe("startIdleNudge", () => {
  it("notifies requesters after a final answer event", async () => {
    vi.useFakeTimers();
    const posts: Array<{ sessionId: string; text: string }> = [];
    const handle = startIdleNudge({
      repo: activeRepo([ev("inject", { source: "discord:111:c:m" })]),
      seconds: 1,
      postToSession: async (input) => {
        posts.push({ sessionId: input.sessionId, text: input.text });
      },
    });

    eventBus.emit({
      type: "transcript.frame",
      target_session_id: "s",
      seq: 1,
      kind: "text",
      payload: { role: "assistant", phase: "final_answer" },
      ts: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(posts).toEqual([{
      sessionId: "s",
      text: "<@111> This session has been waiting for input for 1 seconds after its last answer. Still waiting.",
    }]);
    handle.stop();
  });

  it("clears the armed timer on user_activity", async () => {
    vi.useFakeTimers();
    const posts: Array<{ sessionId: string; text: string }> = [];
    const handle = startIdleNudge({
      repo: activeRepo([ev("inject", { source: "discord:111:c:m" })]),
      seconds: 1,
      postToSession: async (input) => {
        posts.push({ sessionId: input.sessionId, text: input.text });
      },
    });

    eventBus.emit({
      type: "transcript.frame",
      target_session_id: "s",
      seq: 1,
      kind: "summary",
      payload: {},
      ts: 1,
    });
    eventBus.emit({ type: "session.event", session_id: "s", kind: "user_activity", ts: 2 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(posts).toEqual([]);
    handle.stop();
  });
});
