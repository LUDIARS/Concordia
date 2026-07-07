import { describe, it, expect } from "vitest";
import { sanitize, buildRenderPrompt, renderChat, type PersonaVoice } from "../src/chat/render.js";
import { resolveRenderConfig } from "../src/chat/render-config.js";
import { decideRuleFire } from "../src/rules/decide.js";
import type { RuleRow } from "../src/db/rules-repo.js";

const COORDINATOR_VOICE: PersonaVoice = { name: "concordia", display_name: "concordia" };

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
});

describe("resolveRenderConfig (API 不使用 = cli 固定)", () => {
  it("defaults to cli haiku when nothing is specified", () => {
    const c = resolveRenderConfig({ renderer: "", model: "" });
    expect(c.renderer).toBe("cli");
    expect(c.model).toBe("haiku");
  });
  it("coerces the legacy haiku-api renderer to cli", () => {
    const c = resolveRenderConfig({ renderer: "haiku-api", model: "" });
    expect(c.renderer).toBe("cli");
    expect(c.model).toBe("haiku");
  });
  it("respects explicit renderer and model", () => {
    const c = resolveRenderConfig({ renderer: "template", model: "custom" });
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

