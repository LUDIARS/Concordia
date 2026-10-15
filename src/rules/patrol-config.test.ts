import { describe, expect, it } from "vitest";
import { buildMaterialRegistry } from "./patrol-runtime.js";
import { PATROL_HARD_CAPS, parseActionConfig, reviewPatrolConfig } from "./patrol-config.js";

const registry = buildMaterialRegistry({ tendentiaUrl: "http://127.0.0.1:1" });
const base = { kind: "material-chat", source_ids: ["tendentia-public-trends"], scope_key: "hq" };

function review(raw: unknown, trigger: "tick" | "event" = "tick", eventKind: string | null = null) {
  const parsed = parseActionConfig(raw);
  if (!parsed.ok) return parsed;
  return reviewPatrolConfig({ trigger_type: trigger, event_kind: eventKind, config: parsed.config }, registry);
}

describe("parseActionConfig", () => {
  it("fills defaults and rejects unknown keys and broken JSON", () => {
    const parsed = parseActionConfig(JSON.stringify(base));
    expect(parsed.ok && parsed.config.followup.max_replies).toBe(4);
    expect(parsed.ok && parsed.config.renderer).toBe("oneshot");
    expect(parseActionConfig({ ...base, url: "http://evil" }).ok).toBe(false);
    expect(parseActionConfig("{not json").ok).toBe(false);
  });

  it("cannot raise limits above the hard caps (CC-PATROL-07)", () => {
    expect(parseActionConfig({ ...base, root_limit_per_day: PATROL_HARD_CAPS.rootLimitPerDay + 1 }).ok).toBe(false);
    expect(parseActionConfig({ ...base, followup: { max_replies: PATROL_HARD_CAPS.maxReplies + 1 } }).ok).toBe(false);
  });
});

describe("reviewPatrolConfig (CC-PATROL-05)", () => {
  it("accepts a registered public source for hq", () => {
    expect(review(base)).toEqual({ ok: true });
  });

  it("rejects unknown scope, unregistered or unverified sources, and empty tick sources", () => {
    expect(review({ ...base, scope_key: "personal" }).ok).toBe(false);
    expect(review({ ...base, source_ids: ["http://anything"] }).ok).toBe(false);
    const unverified = review({ ...base, source_ids: ["corpus-activity"] });
    expect(unverified.ok === false && unverified.reason).toMatch(/contract-unverified/);
    expect(review({ ...base, source_ids: [] }).ok).toBe(false);
  });

  it("requires service.event with a typed filter for event rules", () => {
    expect(review({ ...base, source_ids: [] }, "event", "chat.posted").ok).toBe(false);
    expect(review({ ...base, source_ids: [] }, "event", "service.event").ok).toBe(false);
    expect(review({ ...base, source_ids: [], filters: { service_codes: ["Mm"] } }, "event", "service.event")).toEqual({ ok: true });
  });

  it("accepts an individual Discord channel only with public scope and a channel ID", () => {
    const channel = "1546109590930853962";
    expect(parseActionConfig(base).ok && (parseActionConfig(base) as { config: { discord_channel_id: unknown } }).config.discord_channel_id).toBeNull();
    const hq = review({ ...base, discord_channel_id: channel });
    expect(hq.ok === false && hq.reason).toMatch(/scope_key=public/);
    expect(review({ ...base, scope_key: "public", discord_channel_id: channel })).toEqual({ ok: true });
    expect(parseActionConfig({ ...base, scope_key: "public", discord_channel_id: "https://discord.com/channels/1/2" }).ok).toBe(false);
  });

  it("rejects oneshot rendering with a zero LLM budget", () => {
    expect(review({ ...base, llm_limit_per_day: 0 }).ok).toBe(false);
    expect(review({ ...base, llm_limit_per_day: 0, renderer: "template" })).toEqual({ ok: true });
  });
});
