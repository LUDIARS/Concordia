import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import {
  GOAL_AND_GO_SOURCE,
  buildGoalAndGoPrompt,
  extractTaskMdPath,
  readGoalAndGoStatus,
  setGoalAndGoEnabled,
  startGoalAndGo,
} from "./goal-and-go.js";

function fakeRepo(metadata: string | null) {
  const session: {
    id: string;
    status: string;
    current_task: string | null;
    metadata: string | null;
  } = {
    id: "s1",
    status: "active",
    current_task: "安定化を完了する",
    metadata,
  };
  const events: Array<{ kind: string; payload: unknown }> = [];
  const repo = {
    findSession: (id: string) => id === session.id ? session : null,
    setMetadata: (_id: string, next: string | null) => { session.metadata = next; },
    patchSession: (_id: string, patch: { current_task?: string | null }) => {
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
  it("is ON by default and preserves explicit legacy overrides", () => {
    expect(readGoalAndGoStatus(null).enabled).toBe(true);
    expect(readGoalAndGoStatus(JSON.stringify({ goal_and_go: true }))).toEqual({
      enabled: true,
      continuation_count: 0,
      started_at: null,
      last_continued_at: null,
      stopped_reason: null,
    });
    expect(readGoalAndGoStatus(JSON.stringify({ goal_and_go: false })).enabled).toBe(false);
    expect(readGoalAndGoStatus(JSON.stringify({ goal_and_go: { enabled: false } })).enabled).toBe(false);
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

  it("drops a missing task markdown before building the continuation prompt", async () => {
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      taskStore: { findByRelativePath: async () => null },
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次タスク: 消えたタスク (spec/tasks/missing.md)", ts: 1 });
    await vi.waitFor(() => expect(injected).toHaveLength(1));

    expect(injected[0]!.text).not.toContain("Cc上の現在タスク:");
    expect(env.session.current_task).toBeNull();
    expect(env.events).toContainEqual(expect.objectContaining({
      kind: "goal_and_go_current_task_dropped",
      payload: { path: "spec/tasks/missing.md", reason: "missing" },
    }));
    handle.stop();
    unsubscribe();
  });

  it("drops a completed task markdown before building the continuation prompt", async () => {
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      taskStore: { findByRelativePath: async () => ({ status: "done" }) },
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次タスク: 完了済み (spec/tasks/done.md)", ts: 1 });
    await vi.waitFor(() => expect(injected).toHaveLength(1));

    expect(injected[0]!.text).not.toContain("Cc上の現在タスク:");
    expect(env.events).toContainEqual(expect.objectContaining({
      kind: "goal_and_go_current_task_dropped",
      payload: { path: "spec/tasks/done.md", reason: "not_pending" },
    }));
    handle.stop();
    unsubscribe();
  });

  it("keeps a pending task markdown in the continuation prompt", async () => {
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      taskStore: { findByRelativePath: async () => ({ status: "pending" }) },
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次タスク: 保留 (spec/tasks/pending.md)", ts: 1 });
    await vi.waitFor(() => expect(injected).toHaveLength(1));

    expect(injected[0]!.text).toContain("Cc上の現在タスク: 次タスク: 保留 (spec/tasks/pending.md)");
    expect(env.session.current_task).toContain("spec/tasks/pending.md");
    handle.stop();
    unsubscribe();
  });

  it("keeps the current task when task markdown validation fails transiently", async () => {
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      taskStore: { findByRelativePath: async () => { throw new Error("temporary read failure"); } },
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次タスク: 保留 (spec/tasks/pending.md)", ts: 1 });
    await vi.waitFor(() => expect(injected).toHaveLength(1));

    expect(injected[0]!.text).toContain("Cc上の現在タスク: 次タスク: 保留 (spec/tasks/pending.md)");
    expect(env.session.current_task).toContain("spec/tasks/pending.md");
    handle.stop();
    unsubscribe();
  });

  it("keeps a current task whose text is not the taskflow path format", () => {
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      taskStore: { findByRelativePath: async () => { throw new Error("must not read"); } },
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
    });

    expect(extractTaskMdPath("次タスク: 手動入力")).toBeNull();
    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次タスク: 手動入力", ts: 1 });

    expect(injected[0]!.text).toContain("Cc上の現在タスク: 次タスク: 手動入力");
    handle.stop();
    unsubscribe();
  });

  it("does not let an older task lookup clear a newer current task", async () => {
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: Array<Extract<ConcordiaEvent, { type: "session.inject" }>> = [];
    let finishLookup!: (task: { status: string } | null) => void;
    const lookup = new Promise<{ status: string } | null>((resolve) => { finishLookup = resolve; });
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      taskStore: { findByRelativePath: () => lookup },
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次タスク: 古いタスク (spec/tasks/old.md)", ts: 1 });
    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次タスク: 手動入力", ts: 2 });
    finishLookup(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(env.session.current_task).toBe("次タスク: 手動入力");
    expect(injected).toHaveLength(1);
    expect(injected[0]!.text).toContain("Cc上の現在タスク: 次タスク: 手動入力");
    expect(env.events).not.toContainEqual(expect.objectContaining({ kind: "goal_and_go_current_task_dropped" }));
    handle.stop();
    unsubscribe();
  });

  it("rejects task paths that can escape or introduce nested path segments", () => {
    expect(extractTaskMdPath("次タスク: traversal (spec/tasks/../private.md)")).toBeNull();
    expect(extractTaskMdPath("次タスク: nested (spec/tasks/nested/task.md)")).toBeNull();
  });

  it("does not continue while an unanswered question blocks the session", async () => {
    // 未回答の ask カードがある間に自走継続を流すと、モデルが自分の質問に自分で答える。
    const env = fakeRepo(setGoalAndGoEnabled(null, true));
    const injected: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "session.inject" && event.source === GOAL_AND_GO_SOURCE) injected.push(event);
    });
    const handle = startGoalAndGo({
      repo: env.repo,
      hasPendingQuestion: () => true,
      seconds: 1,
      maxContinuations: 6,
      maxRuntimeSec: 3600,
      now: () => 100,
    });

    eventBus.emit({ type: "taskflow.continue_requested", target_session_id: "s1", text: "次のタスク", ts: 1 });

    expect(injected).toHaveLength(0);
    // 継続回数も消費しない — 回答後に本来の回数だけ自走できる。
    expect(readGoalAndGoStatus(env.session.metadata).continuation_count).toBe(0);
    handle.stop();
    unsubscribe();
  });

  it("does nothing while the session flag is OFF", async () => {
    vi.useFakeTimers();
    const env = fakeRepo(setGoalAndGoEnabled(null, false));
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
