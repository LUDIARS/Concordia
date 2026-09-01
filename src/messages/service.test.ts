import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionMessagesRepo } from "../db/session-messages-repo.js";
import { SessionMessageService } from "./service.js";
import type { ConcordiaEvent } from "../events.js";

let db: ReturnType<typeof makeTestDb>;
let repo: SessionMessagesRepo;
let listener: ((ev: ConcordiaEvent) => void) | null;
let emitted: ConcordiaEvent[];
let service: SessionMessageService;

beforeEach(() => {
  db = makeTestDb();
  repo = new SessionMessagesRepo(db);
  listener = null;
  emitted = [];
  service = new SessionMessageService({
    repo,
    subscribe: (l) => {
      listener = l;
      return () => { listener = null; };
    },
    emit: (ev) => { emitted.push(ev); },
  });
  service.start();
});

function dispatch(ev: ConcordiaEvent): void {
  listener?.(ev);
}

describe("SessionMessageService", () => {
  it("persists a projected message and emits session.message with op=create", () => {
    dispatch({ type: "transcript.frame", target_session_id: "s1", seq: 1, kind: "text", payload: { role: "user", text: "hi" }, ts: 111 });

    const rows = repo.list("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("hi");
    expect(rows[0].ts).toBe(111);

    const messageEvents = emitted.filter((e) => e.type === "session.message");
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]).toMatchObject({ type: "session.message", target_session_id: "s1", op: "create" });
    expect(messageEvents[0]).toMatchObject({ message: { dedupe_key: "frame:1" } });

    const summaryEvents = emitted.filter((e) => e.type === "session.message.summary");
    expect(summaryEvents).toHaveLength(1);
  });

  it("drops thinking frames by default, and projects them only when enabled", () => {
    const thinking: ConcordiaEvent = {
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 1,
      kind: "thinking",
      payload: { text: "private reasoning" },
      ts: 111,
    };
    dispatch(thinking);
    expect(repo.list("s1")).toHaveLength(0);

    const enabled = new SessionMessageService({
      repo,
      isThinkingEnabled: () => true,
      subscribe: (next) => {
        listener = next;
        return () => { listener = null; };
      },
      emit: (ev) => emitted.push(ev),
    });
    enabled.start();
    dispatch(thinking);
    expect(repo.list("s1")).toHaveLength(1);
  });

  it("routes Task create + tool-result completion to the same row via op=update", () => {
    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 1,
      kind: "tool-use",
      payload: { name: "Task", tool_use_id: "tu-1", task: { subagent_type: "Explore", description: "find" } },
      ts: 100,
    });
    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 2,
      kind: "tool-result",
      payload: { tool_use_id: "tu-1", is_error: false, preview: "found it" },
      ts: 200,
    });

    const rows = repo.list("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("found it");
    expect(rows[0].edited_ts).toBe(200);
    expect(rows[0].author_label).toBe("Explore");

    const ops = emitted.filter((e) => e.type === "session.message").map((e) => (e as { op: string }).op);
    expect(ops).toEqual(["create", "update"]);
  });

  it("updates a normal tool message with only its outcome", () => {
    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 1,
      kind: "tool-use",
      payload: { name: "Bash", tool_use_id: "tu-1", input_preview: '{"command":"secret output"}' },
      ts: 100,
    });
    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 2,
      kind: "tool-result",
      payload: { tool_use_id: "tu-1", is_error: false, preview: "secret result" },
      ts: 200,
    });

    const rows = repo.list("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ author_label: "Bash", content: "成功", edited_ts: 200 });
    expect(rows[0].metadata).toEqual({ tool_use_id: "tu-1", is_error: false, failure: null });
  });

  it("clears stale failure detail when a tool result is replayed without detail", () => {
    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 1,
      kind: "tool-use",
      payload: { name: "Bash", tool_use_id: "tu-replay", input_preview: '{"command":"npm test"}' },
      ts: 100,
    });
    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 2,
      kind: "tool-result",
      payload: { tool_use_id: "tu-replay", is_error: true, preview: "first error" },
      ts: 200,
    });
    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 3,
      kind: "tool-result",
      payload: { tool_use_id: "tu-replay", is_error: false, preview: "ok" },
      ts: 300,
    });

    expect(repo.list("s1")[0].metadata).toEqual({
      tool_use_id: "tu-replay",
      is_error: false,
      failure: null,
    });
  });

  it("preserves the question prompt, options, platform, and metadata across state updates", () => {
    dispatch({
      type: "question.posted",
      target_session_id: "s1",
      question_id: 7,
      question: "どちらにしますか？",
      options: ["A", "B"],
      requester_platform: "discord",
      requester_user_id: "private-user-id",
      ts: 100,
    });
    dispatch({
      type: "question.answered",
      target_session_id: "s1",
      question_id: 7,
      answer_index: 1,
      answer_text: "B",
      ts: 200,
    });
    dispatch({
      type: "question.resolved",
      target_session_id: "s1",
      question_id: 7,
      ts: 300,
    });

    const [row] = repo.list("s1");
    expect(row.content).toBe("どちらにしますか？");
    expect(row.components?.[0]).toMatchObject({ kind: "question_options" });
    expect(row.author_platform).toBe("discord");
    expect(row.metadata).toMatchObject({
      question_id: 7,
      answer_index: 1,
      answer_text: "B",
      answered: true,
      resolved: true,
    });
    expect(row.metadata).not.toHaveProperty("requester_user_id");
  });

  it("returns a cleanup callback that removes its event subscription", () => {
    let activeListener: ((ev: ConcordiaEvent) => void) | null = null;
    const isolated = new SessionMessageService({
      repo,
      subscribe: (next) => {
        activeListener = next;
        return () => { activeListener = null; };
      },
    });

    const stop = isolated.start();
    expect(activeListener).not.toBeNull();
    stop();
    expect(activeListener).toBeNull();
  });

  it("ignores events with no resolvable session id", () => {
    dispatch({ type: "ping", ts: 1 });
    expect(emitted).toHaveLength(0);
  });

  it("does not collapse identical injected messages from the same second", () => {
    const injection: ConcordiaEvent = {
      type: "session.inject",
      target_session_id: "s1",
      text: "repeat",
      source: "web",
      ts: 100,
    };
    dispatch(injection);
    dispatch(injection);
    expect(repo.list("s1").map((row) => row.content)).toEqual(["repeat", "repeat"]);
  });

  it("restores normal tool tool_use_id → dedupe_key context from persisted rows for a session seen again", () => {
    repo.upsert({
      session_id: "s1",
      ts: 50,
      author_type: "tool",
      author_label: "Bash",
      content: "実行中",
      dedupe_key: "frame:9",
      metadata: { tool_use_id: "tu-9" },
    });

    // Fresh service instance simulates a process restart: context map starts empty
    // and must be hydrated from the repo on first touch of the session.
    const restarted = new SessionMessageService({
      repo,
      subscribe: (l) => { listener = l; return () => { listener = null; }; },
      emit: (ev) => emitted.push(ev),
    });
    restarted.start();
    emitted = [];

    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 10,
      kind: "tool-result",
      payload: { tool_use_id: "tu-9", is_error: false, preview: "done after restart" },
      ts: 300,
    });

    const rows = repo.list("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe("frame:9");
    expect(rows[0].content).toBe("成功");
  });

  it("restores Task tool_use_id → dedupe_key context from persisted rows for a session seen again", () => {
    repo.upsert({
      session_id: "s1",
      ts: 50,
      author_type: "task",
      author_label: "Explore",
      content: "find the issue",
      dedupe_key: "task:tu-10",
      metadata: { tool_use_id: "tu-10" },
    });

    // Fresh service instance simulates a process restart: Task mappings must
    // remain available alongside normal tool mappings.
    const restarted = new SessionMessageService({
      repo,
      subscribe: (l) => { listener = l; return () => { listener = null; }; },
      emit: (ev) => emitted.push(ev),
    });
    restarted.start();
    emitted = [];

    dispatch({
      type: "transcript.frame",
      target_session_id: "s1",
      seq: 11,
      kind: "tool-result",
      payload: { tool_use_id: "tu-10", is_error: false, preview: "found it after restart" },
      ts: 300,
    });

    const rows = repo.list("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupe_key: "task:tu-10",
      author_type: "task",
      author_label: "Explore",
      content: "found it after restart",
      edited_ts: 300,
    });
  });
});
