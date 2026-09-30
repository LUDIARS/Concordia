import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegationRepo, DelegationRunRow } from "../../db/delegation-repo.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { createConversationServicePorts } from "./cc-ports.js";
import { ConversationRepo, type ConversationHandoffRow } from "./repo.js";

let conversations: ConversationRepo;
let sessions: Record<string, { status: string; metadata: string | null }>;
let runs: DelegationRunRow[];
let invoke: ReturnType<typeof vi.fn>;
let appendEvent: ReturnType<typeof vi.fn>;
let mergeMetadata: ReturnType<typeof vi.fn>;

function build() {
  return createConversationServicePorts({
    conversations,
    sessions: {
      findSession: (id: string) => sessions[id] ? { id, ...sessions[id] } : null,
      appendEvent,
      mergeMetadata,
    } as unknown as SessionsRepo,
    delegation: {
      listRunsByParentSession: () => runs,
      findRun: (id: string) => runs.find((run) => run.id === id) ?? null,
      findRunByTriggeredBy: (trigger: string) => runs.filter((run) => run.triggered_by === trigger).at(-1) ?? null,
    } as unknown as DelegationRepo,
    delegationService: { invoke } as never,
    pendingQuestions: { listUnanswered: (id: string) => (id === "s1" ? [{} as never] : []) },
    prs: { list: () => [{} as never, {} as never] },
    buildThreadTrigger: (guild, thread) => `discord-forum:${guild}:${thread}`,
    now: () => 5_000,
  });
}

function handoff(overrides: Partial<ConversationHandoffRow> = {}): ConversationHandoffRow {
  const conversation = conversations.ensureConversation({ platform: "discord", scope: "", guildId: "111111", threadId: "222222", ownerSessionId: "s1", now: 1 });
  return {
    id: "hof_1", conversation_id: conversation.conversation_id, from_session_id: "s1", from_generation: 1,
    to_session_id: null, successor_run_id: null, state: "successor_requested", trigger_input_id: null,
    next_instruction: "", package_json: JSON.stringify({
      repo_path: "E:/Document/Ars/Concordia-feat-a", branch: "feat/a", task_references: ["spec/tasks/x.md", "actio:task-a"],
    }), correlation_id: "handoff:hof_1", error: null, created_at: 1_000, updated_at: 2_000,
    package_saved_at: 2_000, switched_at: null, drained_at: null, ...overrides,
  };
}

beforeEach(() => {
  conversations = new ConversationRepo(makeTestDb());
  sessions = {
    s1: { status: "active", metadata: JSON.stringify({ delegation_call_name: "astra-with-sidecar" }) },
    s2: { status: "ended", metadata: null },
  };
  runs = [];
  invoke = vi.fn().mockResolvedValue({ ok: true, run: { id: "run-2", status: "spawned" } });
  appendEvent = vi.fn();
  mergeMetadata = vi.fn();
});

describe("createConversationServicePorts", () => {
  it("derives blocker facts from questions, unfinished children and open PRs", () => {
    runs = [{ id: "r1", status: "running" }, { id: "r2", status: "completed" }] as DelegationRunRow[];
    expect(build().blockerFacts({ sessionId: "s1", conversationId: "c" })).toEqual({
      ownerUnknown: false, unansweredQuestions: 1, unfinishedChildRuns: 1, openPullRequests: 2,
    });
    expect(build().blockerFacts({ sessionId: "missing", conversationId: "c" }).ownerUnknown).toBe(true);
  });

  it("recognises Sidecar parents and session activity", () => {
    const ports = build();
    expect(ports.isSidecarParent("s1")).toBe(true);
    expect(ports.isSidecarParent("s2")).toBe(false);
    expect(ports.sessionActive("s2")).toBe(false);
    expect(ports.sessionActive("missing")).toBeNull();
  });

  it("delivers only to active sessions", async () => {
    const ports = build();
    expect(await ports.deliver({ sessionId: "s2", text: "x", source: "src", authorLabel: null })).toBe("failed");
    expect(await ports.deliver({ sessionId: "s1", text: "x", source: "src", authorLabel: "neco" })).toBe("delivered");
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ session_id: "s1", kind: "inject" }));
  });

  it("starts the successor on the same thread and keeps the existing Actio task", async () => {
    const row = handoff();
    const conversation = conversations.findConversation(row.conversation_id)!;
    const result = await build().startSuccessor({ handoff: row, conversation, brief: "brief" });
    expect(result).toEqual({ ok: true, runId: "run-2" });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      call_name: "astra-with-sidecar",
      task_binding: "caller",
      triggered_by: "discord-forum:111111:222222",
      branch: "feat/a",
      worktree: true,
      args: { task: "brief", target_repo: "E:/Document/Ars/Concordia-feat-a", taskflow_reference: "actio:task-a" },
    }));
  });

  it("refuses to start a successor without an Actio task reference", async () => {
    const row = handoff({ package_json: JSON.stringify({ repo_path: "x", branch: "b", task_references: [] }) });
    const conversation = conversations.findConversation(row.conversation_id)!;
    expect(await build().startSuccessor({ handoff: row, conversation, brief: "" }))
      .toEqual({ ok: false, error: "actio_task_reference_required" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reconciles a lost start only with a run created after the package was saved", () => {
    const row = handoff();
    runs = [{ id: "old", call_name: "astra-with-sidecar", triggered_by: "discord-forum:111111:222222", created_at: 1_500, status: "completed", child_session_id: "s0" }] as DelegationRunRow[];
    expect(build().findSuccessorRun(row)).toBeNull();
    runs.push({ id: "new", call_name: "astra-with-sidecar", triggered_by: "discord-forum:111111:222222", created_at: 2_500, status: "running", child_session_id: "s2" } as DelegationRunRow);
    expect(build().findSuccessorRun(row)).toEqual({ runId: "new", status: "running", childSessionId: "s2" });
  });

  it("requests the predecessor end through the existing speech-end marker", () => {
    build().requestSessionEnd("s1");
    expect(mergeMetadata).toHaveBeenCalledWith("s1", expect.any(Object));
  });
});
