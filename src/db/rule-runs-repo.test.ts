import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuleRunsRepo, type ClaimInput } from "./rule-runs-repo.js";
import { ChatRepo } from "./chat-repo.js";
import { applyMigrations } from "./schema.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function setup() {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  return { db, runs: new RuleRunsRepo(db), chat: new ChatRepo(db) };
}

const claim = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  run_id: "run-1",
  rule_id: "r",
  rule_revision: 1,
  trigger_key: "tick:r:100",
  action_kind: "pick",
  conversation_id: null,
  scope_key: "hq",
  channel: "chitchat",
  lease_owner: "owner-a",
  lease_until: 1000,
  now: 100,
  ...over,
});

describe("RuleRunsRepo", () => {
  it("accepts the same trigger only once (CC-PATROL-03)", () => {
    const { runs } = setup();
    expect(runs.claim(claim())?.status).toBe("claimed");
    expect(runs.claim(claim({ run_id: "run-2" }))).toBeNull();
  });

  it("transitions only with the lease owner and the expected state (CC-PATROL-06)", () => {
    const { runs } = setup();
    runs.claim(claim());
    expect(runs.transition("run-1", "owner-b", ["claimed"], "material_selected", {}, 101)).toBe(false);
    expect(runs.transition("run-1", "owner-a", ["rendering"], "rendered", {}, 101)).toBe(false);
    expect(runs.transition("run-1", "owner-a", ["claimed"], "rendering", { render_attempts_inc: 1 }, 101)).toBe(true);
    expect(runs.find("run-1")).toMatchObject({ status: "rendering", render_attempts: 1 });
  });

  it("commits the chat row and the run link in one transaction, once", () => {
    const { runs, chat } = setup();
    runs.claim(claim());
    runs.transition("run-1", "owner-a", ["claimed"], "rendered", { rendered_text: "hello" }, 101);
    const insert = (text: string) =>
      chat.insert({ channel: "chitchat", session_id: null, author_label: "p", text, in_reply_to: null, is_actionable: false }).id;
    const chatId = runs.commitChat("run-1", "owner-a", 102, insert);
    expect(chatId).not.toBeNull();
    expect(runs.find("run-1")).toMatchObject({ status: "delivery_pending", chat_message_id: chatId });
    expect(runs.commitChat("run-1", "owner-a", 103, insert)).toBeNull();
    expect(chat.list({ channel: "chitchat" })).toHaveLength(1);
  });

  it("does not insert chat when the lease is lost", () => {
    const { runs, chat } = setup();
    runs.claim(claim());
    runs.transition("run-1", "owner-a", ["claimed"], "rendered", { rendered_text: "hello" }, 101);
    const r = runs.commitChat("run-1", "owner-b", 102, (text) =>
      chat.insert({ channel: "chitchat", session_id: null, author_label: "p", text, in_reply_to: null, is_actionable: false }).id);
    expect(r).toBeNull();
    expect(chat.list({})).toHaveLength(0);
  });

  it("finds stale in-flight runs and lets a new owner adopt them", () => {
    const { runs } = setup();
    runs.claim(claim({ lease_until: 150 }));
    expect(runs.listStale(140)).toHaveLength(0);
    expect(runs.listStale(200).map((r) => r.run_id)).toEqual(["run-1"]);
    expect(runs.adopt("run-1", "owner-b", 400, 200)).toBe(true);
    expect(runs.adopt("run-1", "owner-c", 400, 200)).toBe(false);
  });

  it("counts roots and llm calls per day and pages history", () => {
    const { runs } = setup();
    for (let i = 0; i < 3; i++) {
      runs.claim(claim({ run_id: `run-${i}`, trigger_key: `t${i}`, now: 100 + i }));
      runs.transition(`run-${i}`, "owner-a", ["claimed"], "skipped", { llm_calls_inc: 1, source_ref: `item-${i}` }, 100 + i);
    }
    expect(runs.usageSince("r", 0)).toEqual({ roots: 0, llmCalls: 3 });
    expect(runs.usedItemIds("r", 0)).toEqual(new Set(["item-0", "item-1", "item-2"]));
    const first = runs.list({ rule_id: "r", limit: 2 });
    expect(first.runs.map((r) => r.run_id)).toEqual(["run-2", "run-1"]);
    const second = runs.list({ rule_id: "r", limit: 2, cursor: first.next_cursor });
    expect(second.runs.map((r) => r.run_id)).toEqual(["run-0"]);
    expect(second.next_cursor).toBeNull();
  });

  it("keeps delivery_unknown until a platform record is found", () => {
    const { runs } = setup();
    runs.claim(claim());
    runs.transition("run-1", "owner-a", ["claimed"], "rendered", { rendered_text: "x" }, 101);
    runs.commitChat("run-1", "owner-a", 102, () => 1);
    expect(runs.markDelivery("run-1", "delivery_unknown", null, 800)).toBe(true);
    expect(runs.listAwaitingDelivery(900).map((r) => r.status)).toEqual(["delivery_unknown"]);
    expect(runs.markDelivery("run-1", "delivered", "discord:1", 901)).toBe(true);
    expect(runs.find("run-1")).toMatchObject({ status: "delivered", delivery_ref: "discord:1" });
  });
});
