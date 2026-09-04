/** @implements spec/tasks/2026-08-08-delegation-run-watchdog.md */
import { afterEach, describe, expect, it, vi } from "vitest";

import { eventBus, type ConcordiaEvent } from "../events.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";
import {
  DELEGATION_WATCHDOG_SOURCE,
  startDelegationRunWatchdog,
  type DelegationRunWatchdogOptions,
} from "./run-watchdog.js";

const NOW_MS = 1_800_000_000_000;

function run(overrides: Partial<DelegationRunRow> = {}): DelegationRunRow {
  return {
    id: "run-1",
    template_id: null,
    call_name: "implement",
    target_provider: "codex",
    parent_session_id: "parent-1",
    child_session_id: "child-1",
    args_json: "{}",
    rendered_prompt: "",
    prompt_file_path: "",
    spawn_pid: null,
    spawn_command: null,
    triggered_by: null,
    status: "running",
    error: null,
    queue_payload_json: null,
    watchdog_nudge_count: 0,
    watchdog_last_nudge_at: null,
    watchdog_escalated_at: null,
    created_at: NOW_MS - 3_600_000,
    ...overrides,
  } as DelegationRunRow;
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "child-1",
    status: "active",
    ws_clients: 1,
    provider: "codex",
    repo_path: "E:/Document/Ars/Concordia",
    transcript_path: null,
    ...overrides,
  } as SessionRow;
}

function makeDeps(input: {
  runs?: DelegationRunRow[];
  sessions?: Record<string, SessionRow | null>;
  lastActivitySec?: (id: string) => number | null;
  idleSec?: number;
  maxNudges?: number;
  enabled?: boolean;
  escalationAccepted?: boolean;
}) {
  const runsRepo = {
    listActiveRuns: () => input.runs ?? [run()],
    recordWatchdogCheck: vi.fn(),
    recordWatchdogNudge: vi.fn(),
    recordWatchdogEscalation: vi.fn(() => input.escalationAccepted ?? true),
  };
  const sessionsRepo = {
    findSession: (id: string) => (input.sessions ? input.sessions[id] ?? null : session()),
    appendEvent: vi.fn(),
  };
  const options: DelegationRunWatchdogOptions = {
    runs: runsRepo,
    sessions: sessionsRepo,
    lastActivitySec: input.lastActivitySec ?? (() => Math.floor(NOW_MS / 1000) - 3600),
    resolveEnabled: () => input.enabled ?? true,
    resolveIdleSec: () => input.idleSec ?? 1800,
    resolveMaxNudges: () => input.maxNudges ?? 3,
    now: () => NOW_MS,
    readTranscriptTail: async () => null,
  };
  return { runsRepo, sessionsRepo, options };
}

async function runOnceWith(options: DelegationRunWatchdogOptions) {
  const handle = startDelegationRunWatchdog(options);
  try {
    return await handle.runOnce();
  } finally {
    handle.stop();
  }
}

function captureEvents(): { events: ConcordiaEvent[]; stop: () => void } {
  const events: ConcordiaEvent[] = [];
  const unsubscribe = eventBus.subscribe((ev) => {
    events.push(ev);
  });
  return { events, stop: unsubscribe };
}

describe("startDelegationRunWatchdog", () => {
  let stopCapture: (() => void) | null = null;
  afterEach(() => {
    stopCapture?.();
    stopCapture = null;
  });

  it("nudges a stalled child for a status report and persists the nudge", async () => {
    const { runsRepo, sessionsRepo, options } = makeDeps({});
    const capture = captureEvents();
    stopCapture = capture.stop;

    const actions = await runOnceWith(options);

    expect(actions).toEqual([{ runId: "run-1", action: "nudged" }]);
    expect(runsRepo.recordWatchdogNudge).toHaveBeenCalledWith("run-1", NOW_MS, NOW_MS - 3_600_000);
    expect(sessionsRepo.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "child-1",
      kind: "inject",
    }));
    const inject = capture.events.find((ev) => ev.type === "session.inject");
    expect(inject).toMatchObject({
      target_session_id: "child-1",
      source: DELEGATION_WATCHDOG_SOURCE,
    });
    expect((inject as { text: string }).text).toContain("run-1");
  });

  it("does nothing while the child is within the idle threshold", async () => {
    const { runsRepo, options } = makeDeps({
      lastActivitySec: () => Math.floor(NOW_MS / 1000) - 60,
    });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
    // 点検の事実は残す (可視化と再起動後の抑止の根拠)。
    expect(runsRepo.recordWatchdogCheck).toHaveBeenCalledWith("run-1", NOW_MS);
  });

  it("respects the persisted cooldown across restarts", async () => {
    const { runsRepo, options } = makeDeps({
      runs: [run({ watchdog_last_nudge_at: NOW_MS - 60_000, watchdog_nudge_count: 1 })],
    });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
  });

  it("skips a child that is awaiting human input via the ask marker", async () => {
    const { runsRepo, options } = makeDeps({});
    options.readTranscriptTail = async () => '{"role":"assistant","content":"```ask\\n{}\\n```"}';
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
  });

  it("escalates to the parent when the child session has ended without a status report", async () => {
    const { runsRepo, sessionsRepo, options } = makeDeps({
      sessions: { "child-1": session({ status: "ended" }) },
    });
    const capture = captureEvents();
    stopCapture = capture.stop;

    const actions = await runOnceWith(options);

    expect(actions).toEqual([{ runId: "run-1", action: "escalated" }]);
    expect(runsRepo.recordWatchdogEscalation).toHaveBeenCalledWith("run-1", NOW_MS);
    expect(sessionsRepo.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ session_id: "parent-1" }));
    expect(capture.events.some((ev) => ev.type === "delegation.mirror")).toBe(true);
  });

  it("escalates only once — the conditional DB update is the single guard", async () => {
    const { sessionsRepo, options } = makeDeps({
      sessions: { "child-1": null },
      escalationAccepted: false,
    });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(sessionsRepo.appendEvent).not.toHaveBeenCalled();
  });

  it("escalates instead of nudging after max nudges went unanswered", async () => {
    const { runsRepo, options } = makeDeps({
      runs: [run({ watchdog_nudge_count: 3, watchdog_last_nudge_at: NOW_MS - 7_200_000 })],
      lastActivitySec: () => Math.floor((NOW_MS - 10_800_000) / 1000),
    });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([{ runId: "run-1", action: "escalated" }]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
  });

  it("resets the unanswered nudge count after the child resumes", async () => {
    const lastActivityMs = NOW_MS - 3_600_000;
    const { runsRepo, options } = makeDeps({
      runs: [run({ watchdog_nudge_count: 3, watchdog_last_nudge_at: NOW_MS - 7_200_000 })],
      lastActivitySec: () => Math.floor(lastActivityMs / 1000),
    });

    const actions = await runOnceWith(options);

    expect(actions).toEqual([{ runId: "run-1", action: "nudged" }]);
    expect(runsRepo.recordWatchdogNudge).toHaveBeenCalledWith("run-1", NOW_MS, lastActivityMs);
    expect(runsRepo.recordWatchdogEscalation).not.toHaveBeenCalled();
  });

  it("escalates when no live client is attached so the nudge cannot be delivered", async () => {
    const { runsRepo, options } = makeDeps({
      sessions: { "child-1": session({ ws_clients: 0 }) },
    });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([{ runId: "run-1", action: "escalated" }]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
  });

  it("re-sends the delegation prompt when the child never started a turn", async () => {
    // transcript が 1 行も無い = 委託プロンプトが TUI に届かなかった状態。 spawn から
    // 未着手閾値を超えているので、 状況報告ではなく prompt を送り直す。
    const { runsRepo, options } = makeDeps({
      runs: [run({ prompt_file_path: "E:/Document/Ars/Concordia/delegation-prompts/run-1.md" })],
      lastActivitySec: () => null,
    });
    const capture = captureEvents();
    stopCapture = capture.stop;

    const actions = await runOnceWith(options);

    expect(actions).toEqual([{ runId: "run-1", action: "nudged" }]);
    expect(runsRepo.recordWatchdogNudge).toHaveBeenCalledWith("run-1", NOW_MS, NOW_MS - 3_600_000);
    const inject = capture.events.find((ev) => ev.type === "session.inject");
    expect((inject as { text: string }).text).toContain("delegation-prompts/run-1.md");
  });

  it("leaves a freshly spawned child alone until the unstarted threshold passes", async () => {
    const { runsRepo, options } = makeDeps({
      runs: [run({ created_at: NOW_MS - 60_000 })],
      lastActivitySec: () => null,
    });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
  });

  it("does not re-send the prompt again within the unstarted cooldown", async () => {
    const { runsRepo, options } = makeDeps({
      runs: [run({ watchdog_nudge_count: 1, watchdog_last_nudge_at: NOW_MS - 60_000 })],
      lastActivitySec: () => null,
    });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
  });

  it("escalates a never-started run once the re-sends are exhausted", async () => {
    const { runsRepo, options } = makeDeps({
      runs: [run({ watchdog_nudge_count: 3, watchdog_last_nudge_at: NOW_MS - 3_600_000 })],
      lastActivitySec: () => null,
      maxNudges: 3,
    });
    const capture = captureEvents();
    stopCapture = capture.stop;

    const actions = await runOnceWith(options);

    expect(actions).toEqual([{ runId: "run-1", action: "escalated" }]);
    expect(runsRepo.recordWatchdogNudge).not.toHaveBeenCalled();
    const inject = capture.events.find((ev) => ev.type === "session.inject");
    expect((inject as { text: string }).text).toContain("委託プロンプトが届かない");
  });

  it("ignores runs without a claimed child session", async () => {
    const { runsRepo, options } = makeDeps({ runs: [run({ child_session_id: null })] });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(runsRepo.recordWatchdogCheck).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", async () => {
    const { runsRepo, options } = makeDeps({ enabled: false });
    const actions = await runOnceWith(options);
    expect(actions).toEqual([]);
    expect(runsRepo.recordWatchdogCheck).not.toHaveBeenCalled();
  });
});
