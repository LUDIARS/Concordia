import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { RulesRepo } from "../src/db/rules-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { handleAction, _checkForbiddenRule } from "../src/rules/handler.js";

function makeDeps() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return { rules: new RulesRepo(db), chat: new ChatRepo(db) };
}

describe("rule handler — forbidden pattern guard", () => {
  it("rejects add_rule whose id smells like silence-detection", () => {
    const deps = makeDeps();
    const r = handleAction(deps, "_proposer", {
      action: "add_rule",
      rule: {
        id: "long-silence-poke",
        description: "誰も発言していない時に poke",
        trigger_type: "tick",
        tick_sec: 600,
        instructions: "active session の last_seen を見て一定時間 chat が無ければ chitchat に poke",
      },
      reasoning: "test",
    });
    expect(r.applied).toBe(false);
    expect(r.detail).toMatch(/forbidden/);
    expect(deps.rules.find("long-silence-poke")).toBeNull();
  });

  it("rejects add_rule whose description is a progress ping", () => {
    const deps = makeDeps();
    const r = handleAction(deps, "_proposer", {
      action: "add_rule",
      rule: {
        id: "team-pulse",
        description: "他 session に進捗どう?と聞く",
        trigger_type: "tick",
        tick_sec: 600,
        instructions: "consultation に '進捗どう?' と投稿",
      },
      reasoning: "test",
    });
    expect(r.applied).toBe(false);
    expect(r.detail).toMatch(/forbidden/);
  });

  it("rejects English-flavored silence detection", () => {
    const c = _checkForbiddenRule({
      id: "silence-watchdog",
      description: "detect long silence",
      instructions: "...",
    });
    expect(c.ok).toBe(false);
  });

  it("rejects generic chitchat rule", () => {
    const c = _checkForbiddenRule({
      id: "small-talk-random",
      description: "汎用雑談を流す",
      instructions: "天気の話などを投稿",
    });
    expect(c.ok).toBe(false);
  });

  it("allows benign chat hook rule", () => {
    const deps = makeDeps();
    const r = handleAction(deps, "_proposer", {
      action: "add_rule",
      rule: {
        id: "topic-shift-toast",
        description: "新トピックが立ち上がった時に短い乾杯コメント",
        trigger_type: "event",
        event_kind: "session.started",
        instructions: "session.started イベントを受けて chitchat に短く乾杯コメント",
      },
      reasoning: "test",
    });
    expect(r.applied).toBe(true);
    expect(r.action_type).toBe("add_rule");
    expect(deps.rules.find("topic-shift-toast")?.enabled).toBe(1);
  });
});
