import { describe, it, expect, vi, afterEach } from "vitest";
import { startRuleEngine, type EngineDeps } from "./engine.js";
import { eventBus } from "../events.js";

/**
 * rules repo が throw しても engine (event listener / tick timer) が
 * unhandledRejection を漏らさず生存することの回帰テスト。
 * eventBus.emit の try/catch は同期 throw しか捕捉しないため、 async listener の
 * body 全体ガードが無いと SQLITE_BUSY 1 発でプロセスごと落ちる
 * (spec/plan/problems/cc-stability-problems.md A-3)。
 */
describe("rule engine crash guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function throwingDeps() {
    const rules = {
      list: vi.fn(() => {
        throw new Error("SQLITE_BUSY");
      }),
      log: vi.fn(),
      setLastFired: vi.fn(),
    };
    const sessions = { listSessions: vi.fn(() => []) };
    return { deps: { rules, sessions } as unknown as EngineDeps, rules };
  }

  it("event listener survives a throwing rules repo", async () => {
    const { deps, rules } = throwingDeps();
    const engine = startRuleEngine(deps);
    try {
      eventBus.emit({ type: "session.event", session_id: "s", kind: "prompt", ts: 1 });
      // async listener の rejection が漏れていればここで unhandled rejection になる
      await Promise.resolve();
      expect(rules.list).toHaveBeenCalled();
    } finally {
      engine.stop();
    }
  });

  it("tick timer survives a throwing rules repo", async () => {
    vi.useFakeTimers();
    const { deps, rules } = throwingDeps();
    const engine = startRuleEngine(deps);
    try {
      await vi.advanceTimersByTimeAsync(1100);
      expect(rules.list).toHaveBeenCalled();
    } finally {
      engine.stop();
    }
  });
});

describe("rule engine patrol separation (spec/feature/patrol-chat.md §5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps legacy passes on legacy-observe rules and runs patrol rules only through the patrol pass", async () => {
    vi.useFakeTimers();
    const filters: unknown[] = [];
    const rules = {
      list: vi.fn((filter: unknown) => { filters.push(filter); return []; }),
      log: vi.fn(),
      setLastFired: vi.fn(),
    };
    const sessions = { listSessions: vi.fn(() => []) };
    const patrol = {
      runs: { listStale: vi.fn(() => []), listAwaitingDelivery: vi.fn(() => []) },
      conversations: { closeExpired: vi.fn(() => 0) },
      events: { ignoreOlderThan: vi.fn(() => 0) },
      nowMs: () => Date.now(),
    };
    const engine = startRuleEngine({ rules, sessions, patrol } as unknown as EngineDeps);
    try {
      await vi.advanceTimersByTimeAsync(1100);
      expect(filters).toContainEqual({ enabled: true, trigger_type: "tick", execution_mode: "legacy-observe" });
      expect(filters).toContainEqual({ enabled: true, execution_mode: "patrol" });
      expect(patrol.runs.listStale).toHaveBeenCalled();
    } finally {
      engine.stop();
    }
  });
});
