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
