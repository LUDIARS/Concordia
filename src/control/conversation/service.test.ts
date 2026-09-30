import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { ConversationRepo } from "./repo.js";
import {
  ConversationService,
  HANDOFF_PACKAGE_TIMEOUT_MS,
  MAX_CONVERSATION_INPUT_CHARS,
  SUCCESSOR_START_TIMEOUT_MS,
  type ConversationIngressInput,
  type ConversationServicePorts,
  type SuccessorRunFacts,
} from "./service.js";

const PACKAGE = {
  summary: "作業 A を完了",
  decisions: [],
  repo_path: "E:/Document/Ars/Concordia-feat-a",
  branch: "feat/a",
  outputs: ["commit abc1234"],
  remaining: [],
  authorization_scope: "テスト・merge は未許可",
  human_waits: [],
  external_operations: [],
  task_references: ["actio:task-a"],
  references: [],
};

let repo: ConversationRepo;
let now: number;
let sidecarSessions: Set<string>;
let activeSessions: Set<string>;
let blockers: { unansweredQuestions: number; unfinishedChildRuns: number; openPullRequests: number; ownerUnknown: boolean };
let delivered: Array<{ sessionId: string; text: string; source: string }>;
let deliverOutcome: "delivered" | "uncertain" | "failed";
let successorRun: SuccessorRunFacts | null;
let startSuccessor: ReturnType<typeof vi.fn>;
let endRequests: string[];

function ports(): ConversationServicePorts {
  return {
    repo,
    now: () => now,
    isSidecarParent: (id) => sidecarSessions.has(id),
    sessionActive: (id) => activeSessions.has(id),
    blockerFacts: () => blockers,
    deliver: async (input) => {
      delivered.push(input);
      return deliverOutcome;
    },
    startSuccessor: startSuccessor as unknown as ConversationServicePorts["startSuccessor"],
    findSuccessorRun: () => successorRun,
    requestSessionEnd: (id) => endRequests.push(id),
  };
}

function message(id: string, text: string, overrides: Partial<ConversationIngressInput> = {}): ConversationIngressInput {
  return {
    platform: "discord", scope: "", guildId: "111111", threadId: "222222", messageId: id,
    authorId: "900", authorLabel: "neco", text, boundSessionId: "s1", canControlSession: true, ...overrides,
  };
}

beforeEach(() => {
  repo = new ConversationRepo(makeTestDb());
  now = 1_000_000;
  sidecarSessions = new Set(["s1"]);
  activeSessions = new Set(["s1"]);
  blockers = { unansweredQuestions: 0, unfinishedChildRuns: 0, openPullRequests: 0, ownerUnknown: false };
  delivered = [];
  deliverOutcome = "delivered";
  successorRun = null;
  startSuccessor = vi.fn().mockResolvedValue({ ok: true, runId: "run-2" });
  endRequests = [];
});

async function startHandoff(service: ConversationService): Promise<string> {
  const decision = service.accept(message("m-next", "次の作業: ログ画面を直す"));
  expect(decision.action).toBe("handoff_started");
  await Promise.resolve();
  const conversation = repo.findConversation("discord:-:111111:222222")!;
  return conversation.active_handoff_id!;
}

describe("ConversationService.accept", () => {
  it("passes through threads that are not Sidecar conversations", () => {
    const service = new ConversationService(ports());
    expect(service.accept(message("m1", "hi", { boundSessionId: "other" }))).toEqual({ action: "passthrough" });
  });

  it("creates the conversation on first input and routes to the owner", () => {
    const service = new ConversationService(ports());
    const decision = service.accept(message("m1", "設定画面を見て"));
    expect(decision).toMatchObject({ action: "inject", sessionId: "s1" });
    expect(repo.findConversation("discord:-:111111:222222")).toMatchObject({ owner_session_id: "s1", generation: 1 });
  });

  it("suppresses duplicate message ids", () => {
    const service = new ConversationService(ports());
    service.accept(message("m1", "a"));
    expect(service.accept(message("m1", "a"))).toEqual({ action: "duplicate" });
  });

  it("rejects oversized inputs without storing them", () => {
    const service = new ConversationService(ports());
    const decision = service.accept(message("m1", "x".repeat(MAX_CONVERSATION_INPUT_CHARS + 1)));
    expect(decision.action).toBe("reject");
  });

  it("records delivery outcomes and never marks an uncertain inject as delivered", () => {
    const service = new ConversationService(ports());
    const decision = service.accept(message("m1", "a"));
    if (decision.action !== "inject") throw new Error("expected inject");
    expect(service.reportDelivery(decision.inputId, "uncertain", "socket closed")?.state).toBe("uncertain");
    expect(service.reportDelivery(decision.inputId, "delivered", null)).toBeNull();
  });

  it("does not let an unauthorised person start a handoff", () => {
    const service = new ConversationService(ports());
    const decision = service.accept(message("m1", "次の作業", { canControlSession: false }));
    expect(decision).toMatchObject({ action: "inject", sessionId: "s1" });
    expect(repo.findConversation("discord:-:111111:222222")?.state).toBe("active");
  });

  it("holds the handoff while obligations remain and passes the message to the owner", () => {
    blockers = { ...blockers, unansweredQuestions: 1, openPullRequests: 1 };
    const service = new ConversationService(ports());
    const decision = service.accept(message("m1", "次の作業"));
    expect(decision).toMatchObject({ action: "inject", sessionId: "s1" });
    if (decision.action === "inject") expect(decision.reply).toContain("未回答の質問、審査中またはマージ未確認の PR");
    expect(repo.listHandoffs(["handoff_pending"])).toEqual([]);
  });

  it("counts uncertain deliveries as a blocker", () => {
    const service = new ConversationService(ports());
    const first = service.accept(message("m1", "a"));
    if (first.action !== "inject") throw new Error("expected inject");
    service.reportDelivery(first.inputId, "uncertain", "lost");
    expect(service.accept(message("m2", "次の作業")).action).toBe("inject");
  });
});

describe("handoff flow", () => {
  it("asks the predecessor for a package and holds inputs during the handoff", async () => {
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    expect(delivered[0]).toMatchObject({ sessionId: "s1" });
    expect(delivered[0]!.text).toContain(`/v1/delegation/sidecar/handoffs/${handoffId}/package`);
    const held = service.accept(message("m2", "ついでにこれも"));
    expect(held.action).toBe("held");
    expect(repo.countInputs("discord:-:111111:222222", ["held"])).toBe(2);
  });

  it("switches to the successor, delivers held inputs in order and drains the predecessor", async () => {
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    service.accept(message("m2", "held one"));
    service.accept(message("m3", "held two"));

    expect(await service.savePackage(handoffId, "other", PACKAGE)).toEqual({ ok: false, error: "not_handoff_owner" });
    const saved = await service.savePackage(handoffId, "s1", PACKAGE);
    expect(saved).toMatchObject({ ok: true });
    expect(startSuccessor).toHaveBeenCalledTimes(1);
    expect(startSuccessor.mock.calls[0]![0].brief).toContain("ログ画面を直す");
    expect(repo.findHandoff(handoffId)).toMatchObject({ state: "successor_requested", successor_run_id: "run-2" });

    successorRun = { runId: "run-2", status: "running", childSessionId: "s2" };
    activeSessions.add("s2");
    delivered = [];
    await service.advance(handoffId);
    const conversation = repo.findConversation("discord:-:111111:222222")!;
    expect(conversation).toMatchObject({ owner_session_id: "s2", generation: 2, state: "active", active_handoff_id: null });
    expect(repo.findHandoff(handoffId)?.state).toBe("routing_switched");
    expect(delivered.map((item) => [item.sessionId, item.text])).toEqual([["s2", "held one"], ["s2", "held two"]]);
    expect(endRequests).toEqual(["s1"]);
    // きっかけの「次の作業」は引継ぎ本文で渡したので配達済み。
    expect(repo.countInputs(conversation.conversation_id, ["held"])).toBe(0);

    expect(service.accept(message("m4", "after switch"))).toMatchObject({ action: "inject", sessionId: "s2" });

    activeSessions.delete("s1");
    await service.advance(handoffId);
    expect(repo.findHandoff(handoffId)?.state).toBe("predecessor_drained");
  });

  it("does not switch when the package still carries human waits or uncertain operations", async () => {
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    const result = await service.savePackage(handoffId, "s1", { ...PACKAGE, human_waits: ["merge 承認"] });
    expect(result).toMatchObject({ ok: false, error: "handoff_held" });
    expect(repo.findHandoff(handoffId)?.state).toBe("aborted");
    expect(repo.findConversation("discord:-:111111:222222")).toMatchObject({ state: "active", owner_session_id: "s1" });
    expect(startSuccessor).not.toHaveBeenCalled();
  });

  it("rejects an invalid package and keeps waiting", async () => {
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    const result = await service.savePackage(handoffId, "s1", { summary: "" });
    expect(result).toMatchObject({ ok: false, error: "invalid_package" });
    expect(repo.findHandoff(handoffId)?.state).toBe("handoff_pending");
  });

  it("returns to the predecessor on a stop instruction and redelivers held inputs", async () => {
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    service.accept(message("m2", "held"));
    delivered = [];
    const decision = service.accept(message("m3", "停止"));
    expect(decision).toMatchObject({ action: "inject", sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repo.findHandoff(handoffId)).toMatchObject({ state: "aborted", error: "stopped_by_human" });
    expect(repo.findConversation("discord:-:111111:222222")?.state).toBe("active");
    expect(delivered.map((item) => item.text)).toContain("held");
  });

  it("aborts when the package is not saved in time", async () => {
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    now += HANDOFF_PACKAGE_TIMEOUT_MS + 1;
    await service.advance(handoffId);
    expect(repo.findHandoff(handoffId)).toMatchObject({ state: "aborted", error: "package_timeout" });
  });

  it("returns to the predecessor when the successor cannot be started", async () => {
    startSuccessor.mockResolvedValueOnce({ ok: false, error: "actio_task_reference_required" });
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    await service.savePackage(handoffId, "s1", PACKAGE);
    expect(repo.findHandoff(handoffId)).toMatchObject({ state: "failed" });
    expect(repo.findConversation("discord:-:111111:222222")).toMatchObject({ state: "active", owner_session_id: "s1" });
  });

  it("reconciles a lost start response through the run instead of starting twice", async () => {
    startSuccessor.mockRejectedValueOnce(new Error("socket hang up"));
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    await service.savePackage(handoffId, "s1", PACKAGE);
    expect(repo.findHandoff(handoffId)).toMatchObject({ state: "successor_requested", successor_run_id: null });

    successorRun = { runId: "run-9", status: "running", childSessionId: "s9" };
    activeSessions.add("s9");
    await service.advance(handoffId);
    expect(startSuccessor).toHaveBeenCalledTimes(1);
    expect(repo.findHandoff(handoffId)).toMatchObject({ state: "routing_switched", successor_run_id: "run-9", to_session_id: "s9" });
  });

  it("fails the handoff when no successor run appears before the deadline", async () => {
    startSuccessor.mockRejectedValueOnce(new Error("socket hang up"));
    const service = new ConversationService(ports());
    const handoffId = await startHandoff(service);
    await service.savePackage(handoffId, "s1", PACKAGE);
    now += SUCCESSOR_START_TIMEOUT_MS + 1;
    await service.advance(handoffId);
    expect(repo.findHandoff(handoffId)).toMatchObject({ state: "failed", error: "successor_not_found" });
    expect(repo.findConversation("discord:-:111111:222222")?.owner_session_id).toBe("s1");
  });
});
