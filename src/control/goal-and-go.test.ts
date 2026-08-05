import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import {
  GOAL_AND_GO_SOURCE,
  buildGoalAndGoPrompt,
  readGoalAndGoStatus,
  setGoalAndGoEnabled,
  startGoalAndGo,
} from "./goal-and-go.js";

function fakeRepo(metadata: string | null) {
  const session = {
    id: "s1",
    status: "active",
    current_task: "安定化を完了する",
    metadata,
  };
  const events: Array<{ kind: string; payload: unknown }> = [];
  const repo = {
    findSession: (id: string) => id === session.id ? session : null,
    setMetadata: (_id: string, next: string | null) => { session.metadata = next; },
    patchSession: (_id: string, patch: { current_task?: string }) => {
      if (patch.current_task !== undefined) session.current_task = patch.current_task;
    },
    appendEvent: (event: { kind: string; payload: unknown }) => { events.push(event); },
  } as unknown as SessionsRepo;
  return { repo, session, events };
}

function finalFrame(): Extract<ConcordiaEvent, { type: "transcript.frame" }> {
  return {
    type: "transcript.frame",
    target_session_id: "s1",
    seq: 1,
    kind: "text",
    payload: { role: "assistant", phase: "final_answer" },
    ts: 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("goal-and-go metadata", () => {
  it("is OFF by default and reads the legacy boolean flag", () => {
    expect(readGoalAndGoStatus(null).enabled).toBe(false);
    expect(readGoalAndGoStatus(JSON.stringify({ goal_and_go: true }))).toEqual({
      enabled: true,
      continuation_count: 0,
      started_at: null,
      last_continued_at: null,
      stopped_reason: null,
    });
  });

  it("enabling resets the safety budget while preserving unrelated metadata", () => {
    const metadata = setGoalAndGoEnabled(JSON.stringify({ role_label: "実装担当" }), true);
    expect(JSON.parse(metadata)).toMatchObject({
      role_label: "実装担当",
      goal_and_go: { enabled: true, continuation_count: 0, stopped_reason: null },
    });
  });
});

describe("buildGoalAndGoPrompt", () => {
  it("uses an explicitly registered goal", () => {
    const prompt = buildGoalAndGoPrompt({
      metadata: JSON.stringify({ goal: { mode: "scoped", text: "PR作成まで" } }),
      attempt: 1,
      maxContinuations: 6,
    });
    expect(prompt).toContain("明示ゴール: 範囲限定: PR作成まで");
    expect(prompt).toContain("達成度を評価");
  });

  it("falls back to remaining-work inspection without an explicit goal", () => {
    const prompt = buildGoalAndGoPrompt({ metadata: null, currentTask: "テスト", attempt: 2, maxContinuations: 6 });
    expect(prompt).toContain("明示ゴールは登録されていません");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("Cc上の現在タスク: テスト");
  });
});

describe("startGoalAndGo", () => {
  it("no longer injects on idle — continuation moved to the inquiry protocol", async () => {
    // spec/feature/inquiry.md §8: 「idle 経過で自走継続を促す」タイマは撤去した。
    // 継続はお伺い (タスク カテゴリ) の応答と taskflow.continue_requested だけが起こす。
    vi.useFakeTimers();
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
      now: () => 100,
    });

    eventBus.emit(finalFrame());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(injected).toHaveLength(0);
    expect(readGoalAndGoStatus(env.session.metadata).continuation_count).toBe(0);
    handle.stop();
    unsubscribe();
  });

  it("continues via taskflow.continue_requested as before", async () => {
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
      now: () => 100,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次のタスク", ts: 1 });

    expect(injected).toHaveLength(1);
    expect(readGoalAndGoStatus(env.session.metadata).continuation_count).toBe(1);
    handle.stop();
    unsubscribe();
  });

  it("does nothing while the session flag is OFF", async () => {
    vi.useFakeTimers();
    const env = fakeRepo(null);
    const injected: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({ repo: env.repo, seconds: 1, maxContinuations: 6, maxRuntimeSec: 3600 });

    eventBus.emit(finalFrame());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(injected).toEqual([]);
    handle.stop();
    unsubscribe();
  });

  it("human activity clears the timer and resets the safety budget", async () => {
    vi.useFakeTimers();
    const env = fakeRepo(JSON.stringify({
      goal_and_go: {
        enabled: true,
        continuation_count: 3,
        started_at: 10,
        last_continued_at: 20,
        stopped_reason: null,
      },
    }));
    const handle = startGoalAndGo({ repo: env.repo, seconds: 1, maxContinuations: 6, maxRuntimeSec: 3600 });

    eventBus.emit(finalFrame());
    eventBus.emit({ type: "session.event", session_id: "s1", kind: "user_activity", ts: 2 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readGoalAndGoStatus(env.session.metadata)).toMatchObject({
      enabled: true,
      continuation_count: 0,
      started_at: null,
    });
    expect(env.events.some((event) => event.kind === "inject")).toBe(false);
    handle.stop();
  });

  it("stops instead of injecting beyond the continuation limit", async () => {
    // 上限 (maxContinuations) は暴走の最終防波堤として残る (spec §8)。
    // idle タイマは無いので taskflow.continue_requested で上限超過を起こす。
    const env = fakeRepo(JSON.stringify({
      goal_and_go: {
        enabled: true,
        continuation_count: 2,
        started_at: 10,
        last_continued_at: 20,
        stopped_reason: null,
      },
    }));
    const handle = startGoalAndGo({
      repo: env.repo,
      seconds: 1,
      maxContinuations: 2,
      maxRuntimeSec: 3600,
      now: () => 100,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "続き", ts: 1 });

    expect(readGoalAndGoStatus(env.session.metadata).stopped_reason).toBe("continuation_limit");
    expect(env.events.some((event) => event.kind === "goal_and_go_stopped")).toBe(true);
    expect(env.events.some((event) => event.kind === "inject")).toBe(false);
    handle.stop();
  });
});
