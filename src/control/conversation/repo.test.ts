import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { buildConversationId, ConversationRepo } from "./repo.js";

let repo: ConversationRepo;
const base = { platform: "discord", scope: "", guildId: "111111", threadId: "222222", ownerSessionId: "s1", now: 1 };

beforeEach(() => {
  repo = new ConversationRepo(makeTestDb());
});

describe("ConversationRepo", () => {
  it("keeps the logical conversation id separate from the runtime session", () => {
    const conversation = repo.ensureConversation(base);
    expect(conversation.conversation_id).toBe("discord:-:111111:222222");
    expect(conversation).toMatchObject({ owner_session_id: "s1", generation: 1, state: "active", version: 0 });
    // 競合して作られても同じ行へ収束し、担当は最初の値のまま。
    expect(repo.ensureConversation({ ...base, ownerSessionId: "s2" }).owner_session_id).toBe("s1");
    expect(buildConversationId({ platform: "discord", scope: "sub", guildId: "1", threadId: "2" })).toBe("discord:sub:1:2");
  });

  it("changes the owner only through a matching version (CAS)", () => {
    const conversation = repo.ensureConversation(base);
    const moved = repo.compareAndSetConversation(conversation.conversation_id, 0, { owner_session_id: "s2", generation: 2 }, 5);
    expect(moved).toMatchObject({ owner_session_id: "s2", generation: 2, version: 1 });
    expect(repo.compareAndSetConversation(conversation.conversation_id, 0, { owner_session_id: "s3" }, 6)).toBeNull();
    expect(repo.findConversation(conversation.conversation_id)?.owner_session_id).toBe("s2");
  });

  it("deduplicates inputs by platform message id", () => {
    const conversation = repo.ensureConversation(base);
    const input = {
      conversationId: conversation.conversation_id, platformMessageId: "m1", authorId: "u1", authorLabel: "neco",
      intent: "work", text: "hello", generation: 1, state: "received" as const, targetSessionId: "s1", handoffId: null, now: 2,
    };
    const first = repo.insertInput(input);
    const second = repo.insertInput({ ...input, text: "changed" });
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, row: { id: first.row.id, text: "hello" } });
  });

  it("moves input state only from the expected states and drops the text once delivered", () => {
    const conversation = repo.ensureConversation(base);
    const { row } = repo.insertInput({
      conversationId: conversation.conversation_id, platformMessageId: "m1", authorId: "u1", authorLabel: null,
      intent: "work", text: "hello", generation: 1, state: "received", targetSessionId: "s1", handoffId: null, now: 2,
    });
    expect(repo.transitionInput(row.id, ["held"], "delivering", {}, 3)).toBeNull();
    expect(repo.transitionInput(row.id, ["received"], "delivering", {}, 3)?.state).toBe("delivering");
    const delivered = repo.transitionInput(row.id, ["delivering"], "delivered", { error: null }, 4);
    expect(delivered).toMatchObject({ state: "delivered", delivered_at: 4, text: null });
    expect(repo.countInputs(conversation.conversation_id, ["delivered"])).toBe(1);
  });

  it("advances handoffs by state CAS", () => {
    const conversation = repo.ensureConversation(base);
    repo.createHandoff({
      id: "hof_1", conversationId: conversation.conversation_id, fromSessionId: "s1", fromGeneration: 1,
      triggerInputId: null, nextInstruction: "next", correlationId: "handoff:hof_1", now: 10,
    });
    expect(repo.transitionHandoff("hof_1", "handoff_saved", "successor_requested", {}, 11)).toBeNull();
    const saved = repo.transitionHandoff("hof_1", "handoff_pending", "handoff_saved", { package_json: "{}", package_saved_at: 11 }, 11);
    expect(saved).toMatchObject({ state: "handoff_saved", package_saved_at: 11 });
    expect(repo.listHandoffs(["handoff_saved"]).map((row) => row.id)).toEqual(["hof_1"]);
    expect(repo.listHandoffsByConversation(conversation.conversation_id)).toHaveLength(1);
  });
});
