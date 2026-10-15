import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuleConversationsRepo } from "./rule-conversations-repo.js";
import { applyMigrations } from "./schema.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function setup() {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const repo = new RuleConversationsRepo(db);
  repo.open({
    conversation_id: "c1", rule_id: "r", rule_revision: 1, root_chat_id: 10, channel: "chitchat",
    scope_key: "hq", source_ref: "hn:k1", expires_at: 1000, now: 100,
  });
  return repo;
}

describe("RuleConversationsRepo", () => {
  it("resolves the conversation from root and later bot messages", () => {
    const repo = setup();
    expect(repo.findByBotMessage(10)?.conversation_id).toBe("c1");
    repo.recordBotTurn("c1", 20, "reply", 200);
    expect(repo.findByBotMessage(20)?.conversation_id).toBe("c1");
    expect(repo.find("c1")).toMatchObject({ last_bot_message_id: 20, reply_count: 1, unprompted_count: 0 });
    repo.recordBotTurn("c1", 30, "followup", 300);
    expect(repo.find("c1")).toMatchObject({ unprompted_count: 1, last_bot_at: 300 });
  });

  it("receives each inbound once, in order, and settles them", () => {
    const repo = setup();
    expect(repo.recordInbound(12, "c1", 110)).toBe(true);
    expect(repo.recordInbound(11, "c1", 111)).toBe(true);
    expect(repo.recordInbound(12, "c1", 112)).toBe(false);
    expect(repo.pendingInbound("r").map((i) => i.inbound_chat_id)).toEqual([11, 12]);
    expect(repo.inboundSince("c1", 11)).toBe(1);
    repo.settleInbound([11, 12], "answered", "run-x", null);
    expect(repo.pendingInbound("r")).toHaveLength(0);
  });

  it("closes expired conversations and drops their pending replies", () => {
    const repo = setup();
    repo.recordInbound(12, "c1", 110);
    expect(repo.listOpen("r", 500)).toHaveLength(1);
    expect(repo.closeExpired(1000)).toBe(1);
    expect(repo.listOpen("r", 500)).toHaveLength(0);
    expect(repo.listInbound("c1")[0]).toMatchObject({ status: "dropped", reason: "conversation expired" });
  });
});
