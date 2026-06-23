import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { PersonasRepo } from "../src/db/personas-repo.js";
import { seedPersonas } from "../src/personas/seeds.js";
import { sanitize, buildRenderPrompt, renderChat } from "../src/chat/render.js";
import { resolveRenderConfig } from "../src/chat/render-config.js";
import { decideRuleFire } from "../src/rules/decide.js";
import { ChatResponder, COORDINATOR_VOICE } from "../src/chat/responder.js";
import type { RuleRow } from "../src/db/rules-repo.js";

function rule(partial: Partial<RuleRow>): RuleRow {
  return {
    id: "r", description: null, trigger_type: "tick", tick_sec: 300, event_kind: null,
    conditions: "[]", instructions: "x", target: null, cooldown_sec: 300,
    last_fired_at: null, enabled: 1, added_at: 0, added_by: "system",
    removed_at: null, removed_by: null, removed_reason: null, ...partial,
  };
}

describe("render.sanitize", () => {
  it("strips wrapping quotes and code fences", () => {
    expect(sanitize('"hello"')).toBe("hello");
    expect(sanitize("「やあ」")).toBe("やあ");
    expect(sanitize("```\ncode\n```")).toBe("code");
  });
  it("returns null for empty", () => {
    expect(sanitize("   ")).toBeNull();
  });
});

describe("render.buildRenderPrompt", () => {
  it("includes persona voice, intent and channel", () => {
    const p = buildRenderPrompt({
      persona: { name: "テスト魂", display_name: "境野", speech_style: "淡々と", traits: ["厳密"] },
      channel: "chitchat",
      intent: "chitchat",
      context: { seed: "種", recent: ["[chitchat] x: hi"] },
    });
    expect(p).toMatch(/テスト魂/);
    expect(p).toMatch(/chitchat/);
    expect(p).toMatch(/淡々と/);
  });
});

describe("render template mode (no LLM)", () => {
  it("returns the seed text verbatim", async () => {
    const out = await renderChat(
      { persona: COORDINATOR_VOICE, channel: "chitchat", intent: "chitchat", context: { seed: "場をつなぐ一言" } },
      { renderer: "template", model: "" },
    );
    expect(out).toBe("場をつなぐ一言");
  });
  it("haiku-api without key returns null (no silent fallback)", async () => {
    const out = await renderChat(
      { persona: COORDINATOR_VOICE, channel: "chitchat", intent: "chitchat", context: { seed: "x" } },
      { renderer: "haiku-api", model: "claude-haiku-4-5" }, // apiKey 未指定
    );
    expect(out).toBeNull();
  });
});

describe("resolveRenderConfig", () => {
  it("uses haiku-api when an API key is present", () => {
    const c = resolveRenderConfig({ renderer: "", model: "", reportModel: "claude-haiku-4-5", apiKey: "sk-x" });
    expect(c.renderer).toBe("haiku-api");
    expect(c.model).toBe("claude-haiku-4-5");
    expect(c.apiKey).toBe("sk-x");
  });
  it("falls back to cli haiku without an API key", () => {
    const c = resolveRenderConfig({ renderer: "", model: "", reportModel: "claude-haiku-4-5", apiKey: "" });
    expect(c.renderer).toBe("cli");
    expect(c.model).toBe("haiku");
  });
  it("respects explicit renderer and model", () => {
    const c = resolveRenderConfig({ renderer: "template", model: "custom", reportModel: "r", apiKey: "" });
    expect(c.renderer).toBe("template");
    expect(c.model).toBe("custom");
  });
});

describe("decideRuleFire (black-box, deterministic)", () => {
  it("does not fire when any_active_session and there are none", () => {
    const d = decideRuleFire(rule({ conditions: JSON.stringify([{ type: "any_active_session" }]) }), { nowSec: 0, activeSessionCount: 0 });
    expect(d.fire).toBe(false);
  });
  it("fires and defaults to chitchat when active sessions exist", () => {
    const d = decideRuleFire(rule({ conditions: JSON.stringify([{ type: "any_active_session" }]) }), { nowSec: 0, activeSessionCount: 2 });
    expect(d.fire).toBe(true);
    expect(d.channel).toBe("chitchat");
    expect(d.intent).toBe("chitchat");
  });
  it("resolves channel/intent from conditions", () => {
    const d = decideRuleFire(
      rule({ conditions: JSON.stringify([{ type: "channel", value: "consultation" }]) }),
      { nowSec: 0, activeSessionCount: 1 },
    );
    expect(d.channel).toBe("consultation");
    expect(d.intent).toBe("consult");
  });
  it("falls back to rule.target for channel", () => {
    const d = decideRuleFire(rule({ target: "報告" }), { nowSec: 0, activeSessionCount: 1 });
    expect(d.channel).toBe("報告");
    expect(d.intent).toBe("notice");
  });
});

describe("ChatResponder (template mode)", () => {
  function env() {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const chat = new ChatRepo(db);
    const personas = new PersonasRepo(db);
    seedPersonas(personas);
    const responder = new ChatResponder({
      chat, personas, sessions,
      renderConfig: () => ({ renderer: "template", model: "" }),
    });
    return { db, sessions, chat, personas, responder };
  }

  it("posts a coordinator chitchat from a seed", async () => {
    const e = env();
    await e.responder.speak({ channel: "chitchat", intent: "chitchat", sessionId: null, context: { seed: "やあ" } });
    const msgs = e.chat.list({ limit: 10 });
    expect(msgs.length).toBe(1);
    expect(msgs[0].text).toBe("やあ");
    expect(msgs[0].author_label).toBe("concordia");
  });

  it("uses the assigned persona's display_name as author", async () => {
    const e = env();
    e.sessions.insertSession({
      id: "s1", provider: "claude-code", repo_path: "/x", repo_origin: null, branch: "main",
      host: "h", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
    });
    const a = e.personas.assign("s1");
    expect(a).not.toBeNull();
    await e.responder.speak({ channel: "chitchat", intent: "reply", sessionId: "s1", context: { trigger: "hello" } });
    const msgs = e.chat.list({ limit: 10 });
    expect(msgs.length).toBe(1);
    expect(msgs[0].author_label).toBe(a!.persona.display_name || a!.persona.name);
  });

  it("fans out to dispatcher with the message and depth", async () => {
    const e = env();
    const seen: Array<{ id: number; depth: number }> = [];
    e.responder.attachFanout({ onChatPosted: (m, depth) => seen.push({ id: m.id, depth }) });
    await e.responder.speak({ channel: "chitchat", intent: "chitchat", sessionId: null, context: { seed: "hi" }, replyDepth: 1 });
    expect(seen.length).toBe(1);
    expect(seen[0].depth).toBe(1);
  });

  it("does nothing when chat is muted", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const chat = new ChatRepo(db);
    const personas = new PersonasRepo(db);
    const responder = new ChatResponder({
      chat, personas, sessions,
      renderConfig: () => ({ renderer: "template", model: "" }),
      isChatMuted: () => true,
    });
    await responder.speak({ channel: "chitchat", intent: "chitchat", sessionId: null, context: { seed: "x" } });
    expect(chat.list({ limit: 10 }).length).toBe(0);
  });
});
