import { describe, expect, it } from "vitest";
import { LAST_RESPONSE_MAX_CHARS, buildTaskExecutionView } from "./execution-view.js";

type RunInput = Parameters<typeof buildTaskExecutionView>[0]["run"];
type SessionInput = Parameters<typeof buildTaskExecutionView>[0]["session"];

const run = (status: NonNullable<RunInput>["status"], error: string | null = null): RunInput => ({
  status, error, spawn_branch: "feat/task",
});
const session = (status: NonNullable<SessionInput>["status"]): SessionInput => ({
  status, started_at: 100, ended_at: null, current_task: "Cc task",
});

describe("buildTaskExecutionView", () => {
  it("derives the execution state from run and child session, independent of task status", () => {
    expect(buildTaskExecutionView({ run: null, session: null, pr: null, tail: null }).state).toBe("not_started");
    expect(buildTaskExecutionView({ run: run("queued"), session: null, pr: null, tail: null }).state).toBe("queued");
    expect(buildTaskExecutionView({ run: run("pending"), session: null, pr: null, tail: null }).state).toBe("launching");
    expect(buildTaskExecutionView({ run: run("spawned"), session: session("active"), pr: null, tail: null }).state).toBe("received");
    expect(buildTaskExecutionView({ run: run("running"), session: session("active"), pr: null, tail: null }).state).toBe("working");
    expect(buildTaskExecutionView({ run: run("running"), session: session("blocked"), pr: null, tail: null }).state).toBe("waiting");
    expect(buildTaskExecutionView({ run: run("blocked", "人間の回答待ち"), session: session("active"), pr: null, tail: null }).state).toBe("waiting");
    expect(buildTaskExecutionView({ run: run("completed"), session: session("ended"), pr: null, tail: null }).state).toBe("finished");
    expect(buildTaskExecutionView({ run: null, session: session("active"), pr: null, tail: null }).state).toBe("received");
  });

  it("reports why the work stopped, and nothing while it is running", () => {
    expect(buildTaskExecutionView({ run: run("failed", "completed rejected: no evidence"), session: session("ended"), pr: null, tail: null })
      .stop_reason).toBe("completed rejected: no evidence");
    expect(buildTaskExecutionView({ run: run("spawn_failed"), session: null, pr: null, tail: null }).stop_reason).toBe("run spawn_failed");
    const ended = buildTaskExecutionView({ run: run("running"), session: session("ended"), pr: null, tail: null });
    expect(ended.state).toBe("stopped");
    expect(ended.stop_reason).toBe("子セッションが完了報告の前に終了した");
    expect(buildTaskExecutionView({ run: run("running"), session: session("lost"), pr: null, tail: null }).stop_reason)
      .toBe("子セッションとの接続が失われた");
    expect(buildTaskExecutionView({ run: run("running"), session: session("active"), pr: null, tail: null }).stop_reason).toBeNull();
  });

  it("shows the receipt time, latest tool name and a truncated last response", () => {
    const long = "あ".repeat(LAST_RESPONSE_MAX_CHARS + 10);
    const view = buildTaskExecutionView({
      run: run("running"),
      session: session("active"),
      pr: null,
      tail: {
        lastText: { ts: 300, payload: { role: "assistant", text: `  ${long}\n` } },
        lastToolUse: { ts: 310, payload: { name: "Bash", input_preview: "{\"command\":\"cat secret.env\"}" } },
      },
    });
    expect(view.received_at).toBe(100);
    expect(view.current_action).toEqual({ label: "Bash", source: "tool", at: 310 });
    expect(JSON.stringify(view)).not.toContain("secret.env");
    expect([...view.last_response!.text]).toHaveLength(LAST_RESPONSE_MAX_CHARS + 1);
    expect(view.last_response!.text.endsWith("…")).toBe(true);
    expect(view.last_response!.at).toBe(300);
  });

  it("falls back to the session task and leaves unknown items null", () => {
    const view = buildTaskExecutionView({
      run: run("running"),
      session: session("active"),
      pr: null,
      tail: { lastText: { ts: 1, payload: { role: "user", text: "人間の発言" } }, lastToolUse: null },
    });
    expect(view.current_action).toEqual({ label: "Cc task", source: "current_task", at: null });
    expect(view.last_response).toBeNull();
    expect(buildTaskExecutionView({ run: null, session: null, pr: null, tail: null })).toMatchObject({
      received_at: null, current_action: null, last_response: null, stop_reason: null, artifacts: [],
    });
  });

  it("lists PR and work branch as artifacts", () => {
    const view = buildTaskExecutionView({
      run: run("completed"),
      session: session("ended"),
      pr: { number: 42, url: "https://github.com/LUDIARS/repo/pull/42", state: "merged" },
      tail: null,
    });
    expect(view.artifacts).toEqual([
      { kind: "pr", label: "#42 · merged", url: "https://github.com/LUDIARS/repo/pull/42" },
      { kind: "branch", label: "feat/task", url: null },
    ]);
  });
});
