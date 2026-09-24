import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventBus } from "../events.js";
import { transitionWorkPhase, WORK_PHASE_KEY } from "../work/session-work-phase.js";
import { startForumPhaseTitleSync } from "./forum-phase-sync.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
function setup() {
  const session = { repo_path: "/repo", branch: "feature", current_task: "task", status: "active", metadata: null as string | null };
  const phase = transitionWorkPhase(session, {
    expected_revision: 0, phase: "implementation", design_summary: "Approved scope",
    reason: "Human start", approval_reference: "開始する",
  }, 123);
  session.metadata = JSON.stringify({ [WORK_PHASE_KEY]: phase });
  const row = { session_id: "session", channel_id: "thread", channel_kind: "thread", status: "active", name_locked: 1 };
  const thread = {
    id: "thread", type: ChannelType.PublicThread, parent: { type: ChannelType.GuildForum },
    name: "🌟 [Cc] 手動の名前", archived: false,
    setName: vi.fn(async (name: string) => { thread.name = name; }),
  };
  const fetch = vi.fn(async () => thread);
  const deps = {
    guild: { channels: { cache: new Map(), fetch } } as any,
    channels: { findBySessionId: () => row, listAll: () => [row] } as any,
    sessions: { findSession: () => session } as any,
    ownsSession: vi.fn(() => true), log: { warn: vi.fn() },
  };
  const sync = startForumPhaseTitleSync(deps);
  cleanups.push(sync.stop);
  return { session, row, thread, fetch, deps, sync };
}

describe("persisted phase title synchronization", () => {
  it("reconciles locked names at startup and avoids unchanged renames", async () => {
    const { sync, thread } = setup();
    await sync.reconcile();
    expect(thread.name).toBe("🌟 [Cc] [実装] 手動の名前");
    await sync.reconcile();
    expect(thread.setName).toHaveBeenCalledTimes(1);
  });
  it("uses unknown after a task binding changes through an event", async () => {
    const { sync, session, thread } = setup();
    await sync.reconcile();
    session.current_task = "new scope";
    eventBus.emit({ type: "session.task_changed", session_id: "session", previous_task: "task", current_task: "new scope", ts: 1 });
    await sync.refresh("session");
    expect(thread.name).toBe("🌟 [Cc] [未確認] 手動の名前");
  });
  it("reflects a persisted phase-only change from the event bus", async () => {
    const { sync, session, thread } = setup();
    await sync.reconcile();
    const phase = transitionWorkPhase(session, {
      expected_revision: 1, phase: "adjustment", design_summary: "Approved scope", reason: "Review fixes",
    }, 124);
    session.metadata = JSON.stringify({ [WORK_PHASE_KEY]: phase });
    eventBus.emit({ type: "session.event", session_id: "session", kind: "work_phase_changed", ts: 124 });
    await sync.refresh("session");
    expect(thread.name).toBe("🌟 [Cc] [調整] 手動の名前");
  });
  it("retries a failed rename on the periodic pass", async () => {
    vi.useFakeTimers();
    const { sync, thread, deps } = setup();
    thread.setName.mockRejectedValueOnce(new Error("Discord unavailable"));
    await sync.reconcile();
    expect(deps.log.warn).toHaveBeenCalledOnce();
    expect(thread.name).toBe("🌟 [Cc] 手動の名前");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(thread.name).toBe("🌟 [Cc] [実装] 手動の名前");
  });
  it("reads latest phase after fetch and coalesces repeated events", async () => {
    const { sync, thread, fetch, session } = setup();
    let release!: (value: typeof thread) => void;
    fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const done = sync.reconcile();
    await Promise.resolve();
    session.branch = "new scope";
    for (let i = 0; i < 5; i++) eventBus.emit({ type: "session.event", session_id: "session", kind: "work_phase_changed", ts: i });
    release(thread);
    await done;
    expect(thread.name).toBe("🌟 [Cc] [未確認] 手動の名前");
    expect(thread.setName).toHaveBeenCalledTimes(1);
  });
  it("does not rename after stopping during a fetch", async () => {
    vi.useFakeTimers();
    const { sync, thread, fetch } = setup();
    let release!: (value: typeof thread) => void;
    fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const done = sync.reconcile();
    await Promise.resolve();
    sync.stop();
    release(thread);
    await done;
    eventBus.emit({ type: "session.event", session_id: "session", kind: "work_phase_changed", ts: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(thread.setName).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["foreign", "ended", "archived", "text"])("skips %s surfaces", async (kind) => {
    const { sync, thread, session, row, deps } = setup();
    if (kind === "foreign") deps.ownsSession.mockReturnValue(false);
    if (kind === "ended") session.status = "ended";
    if (kind === "archived") thread.archived = true;
    if (kind === "text") row.channel_kind = "text";
    await sync.reconcile();
    expect(thread.setName).not.toHaveBeenCalled();
  });
});
