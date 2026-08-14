import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import { makeDiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { readTeardownLadder } from "./teardown-ladder.js";
import { startAskDetachWatch } from "./ask-detach.js";

function makeRun(overrides: Partial<DelegationRunRow> = {}): DelegationRunRow {
  return {
    id: "run-1",
    call_name: "claude-impl",
    args_json: JSON.stringify({ task: "do the thing" }),
    parent_session_id: "parent-1",
    child_session_id: "child-1",
    status: "running",
    error: null,
    target_provider: "claude",
    effective_model: "claude-opus-5",
    effort_level: "high",
    fast_mode: 0,
    team_id: null,
    spawn_cwd: "E:/repo",
    spawn_branch: "feat/x",
    spawn_worktree_path: "E:/wt/repo-task",
    ...overrides,
  } as DelegationRunRow;
}

function setup(run: DelegationRunRow) {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const questions = makeDiscordPendingQuestionsRepo(db);
  sessions.insertSession({
    id: "child-1",
    provider: "claude-code",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/x",
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
  const runs = {
    listActiveRuns: vi.fn(() => (["launching", "spawned", "running"].includes(run.status) ? [run] : [])),
    recentRuns: vi.fn(() => [run]),
    updateRunStatus: vi.fn((_id: string, status: string, error: string) => {
      run.status = status as DelegationRunRow["status"];
      run.error = error;
    }),
  };
  const service = { invoke: vi.fn(async (_input: Record<string, unknown>) => ({ ok: true as const })) };
  return { sessions, questions, runs, service, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startAskDetachWatch", () => {
  it("detachSec を超えて未回答の質問を持つ run を blocked に切り離す", async () => {
    vi.useFakeTimers();
    const { sessions, questions, runs, service, run } = setup(makeRun());
    const question = questions.insert({ session_id: "child-1", question: "どちらにしますか?", options: ["A", "B"] });
    // 質問 ts は実時間 (秒)。 scan 側の now を detachSec より先へ進めて経過超過にする。
    const nowSec = () => question.ts + 1800;
    const watch = startAskDetachWatch({
      sessions,
      runs: runs as any,
      questions,
      service: service as any,
      detachSec: 1800,
      intervalMs: 1000,
      nowSec,
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(run.status).toBe("blocked");
      expect(run.error).toBe(`awaiting_question:${question.id}`);
      expect(questions.findById(question.id)?.question).toContain("回答すると新しい run で再開します");
      const session = sessions.findSession("child-1")!;
      const metadata = JSON.parse(session.metadata ?? "{}") as Record<string, unknown>;
      expect(metadata.ask_detached_run_id).toBe("run-1");
      expect(metadata.ask_detached_question_id).toBe(question.id);
      expect(sessions.eventsByKind("child-1", "ask_detached")).toHaveLength(1);
      // 子セッションには teardown ladder が予約される (session-end へ誘導)。
      expect(readTeardownLadder(session.metadata)?.run_key).toBe("ask-detach:run-1");
    } finally {
      watch.stop();
    }
  });

  it("detachSec 未満の未回答質問では切り離さない", async () => {
    vi.useFakeTimers();
    const { sessions, questions, runs, service, run } = setup(makeRun());
    const question = questions.insert({ session_id: "child-1", question: "確認です", options: ["A"] });
    const watch = startAskDetachWatch({
      sessions,
      runs: runs as any,
      questions,
      service: service as any,
      detachSec: 1800,
      intervalMs: 1000,
      nowSec: () => question.ts + 60,
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(run.status).toBe("running");
      expect(runs.updateRunStatus).not.toHaveBeenCalled();
    } finally {
      watch.stop();
    }
  });

  it("回答が来たら worktree / branch / runtime を継承した新 run で再開する", async () => {
    const run = makeRun({
      status: "blocked",
      error: "awaiting_question:7",
      fast_mode: 1,
      team_id: "team-1",
    });
    const { sessions, questions, runs, service } = setup(run);
    const watch = startAskDetachWatch({
      sessions,
      runs: runs as any,
      questions,
      service: service as any,
      detachSec: 1800,
      intervalMs: 60_000,
    });
    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "child-1",
        question_id: 7,
        answer_index: 0,
        answer_text: "B 案で進めて",
        ts: 100,
      });
      await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledOnce());
      const input = service.invoke.mock.calls[0]![0]!;
      expect(input.call_name).toBe("claude-impl");
      expect(input.args).toEqual({ task: "do the thing" });
      expect(input.parent_session_id).toBe("parent-1");
      expect(input.cwd).toBe("E:/wt/repo-task");
      expect(input.branch).toBe("feat/x");
      expect(input.worktree).toBe(false);
      expect(input.triggered_by).toBe("ask-resume:run-1");
      expect(input.options).toEqual({ team: "team-1", fast_mode: true });
      expect(input.overrides).toEqual({ provider: "claude", model: "claude-opus-5", reasoning_effort: "high" });
      expect(input.extra_prompt).toContain("B 案で進めて");
      expect(input.extra_prompt).toContain("run-1");
    } finally {
      watch.stop();
    }
  });

  it("別の質問への回答では再開しない", async () => {
    const run = makeRun({ status: "blocked", error: "awaiting_question:7" });
    const { sessions, questions, runs, service } = setup(run);
    const watch = startAskDetachWatch({
      sessions,
      runs: runs as any,
      questions,
      service: service as any,
      detachSec: 1800,
      intervalMs: 60_000,
    });
    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "child-1",
        question_id: 8,
        answer_index: 0,
        answer_text: "違う質問",
        ts: 100,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.invoke).not.toHaveBeenCalled();
    } finally {
      watch.stop();
    }
  });

  it("worktree が無い run は spawn_cwd へフォールバックして再開する", async () => {
    const run = makeRun({
      status: "blocked",
      error: "awaiting_question:7",
      spawn_worktree_path: null,
    });
    const { sessions, questions, runs, service } = setup(run);
    const watch = startAskDetachWatch({
      sessions,
      runs: runs as any,
      questions,
      service: service as any,
      detachSec: 1800,
      intervalMs: 60_000,
    });
    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "child-1",
        question_id: 7,
        answer_index: 0,
        answer_text: "OK",
        ts: 100,
      });
      await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledOnce());
      const input = service.invoke.mock.calls[0]![0]!;
      expect(input.cwd).toBe("E:/repo");
    } finally {
      watch.stop();
    }
  });
});
