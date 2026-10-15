import { describe, expect, it } from "vitest";
import type { Material } from "./material-types.js";
import { PatrolActionConfig } from "./patrol-config.js";
import {
  canReply,
  choosePatrolAction,
  computeNextDueAt,
  evaluateFollowup,
  pickMaterial,
  seededRandom,
  stopReason,
  type ChooseInput,
} from "./patrol-policy.js";

const NOW_MS = Date.parse("2026-10-15T12:00:00Z");
const NOW_SEC = NOW_MS / 1000;

const config = PatrolActionConfig.parse({
  kind: "material-chat",
  source_ids: ["tendentia-public-trends"],
  scope_key: "hq",
  filters: { genres: ["tech", "ai"], max_age_sec: 86400 },
});

function material(id: string, over: Partial<Material> = {}): Material {
  return {
    sourceId: "tendentia-public-trends",
    itemId: id,
    version: `${id}:v1`,
    kind: "trend",
    serviceCode: "Td",
    featureKey: "tech",
    occurredAt: new Date(NOW_MS - 3600_000).toISOString(),
    observedAt: new Date(NOW_MS).toISOString(),
    title: `title ${id}`,
    excerpt: "",
    scopeKey: "public",
    shareableTo: ["*"],
    tags: ["tech"],
    ...over,
  };
}

describe("seededRandom / computeNextDueAt (CC-PATROL-01)", () => {
  it("returns the same sequence for the same seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seededRandom(43)()).not.toBe(seededRandom(42)());
  });

  it("adds a deterministic jitter within 10% of the interval", () => {
    const due = computeNextDueAt("rule-a", 1800, 1000);
    expect(due).toBe(computeNextDueAt("rule-a", 1800, 1000));
    expect(due).toBeGreaterThanOrEqual(1000 + 1800);
    expect(due).toBeLessThan(1000 + 1800 + 180);
  });
});

describe("pickMaterial", () => {
  const ctx = (used: string[] = [], seed = 7) => ({
    nowMs: NOW_MS,
    scopeKey: "hq",
    config,
    usedItemIds: new Set(used),
    random: seededRandom(seed),
  });

  it("picks the same item for the same input and seed, without an LLM", () => {
    const items = [material("a"), material("b"), material("c")];
    const first = pickMaterial(items, ctx());
    const second = pickMaterial(items, ctx());
    expect(first.picked?.itemId).toBe(second.picked?.itemId);
    expect(first.candidateCount).toBe(3);
  });

  it("excludes used, stale, out-of-scope and filtered items with a reason", () => {
    const items = [
      material("used"),
      material("stale", { occurredAt: new Date(NOW_MS - 2 * 86400_000).toISOString() }),
      material("private", { shareableTo: ["other-team"] }),
      material("food", { tags: ["food"] }),
    ];
    const r = pickMaterial(items, ctx(["used"]));
    expect(r.picked).toBeNull();
    expect(r.reason).toMatch(/no eligible material/);
    expect(pickMaterial([], ctx()).reason).toBe("no material");
  });

  it("prefers fresher items and does not always pick the first one", () => {
    const fresh = [material("x"), material("y")];
    const old = material("old", { occurredAt: new Date(NOW_MS - 80_000_000).toISOString() });
    const picks = new Set<string>();
    for (let seed = 0; seed < 20; seed++) picks.add(pickMaterial([old, ...fresh], ctx([], seed)).picked!.itemId);
    expect(picks.has("old")).toBe(false);
    expect(picks).toEqual(new Set(["x", "y"]));
  });
});

describe("stop / reply / followup", () => {
  const stop = { runtimeDisabled: false, ruleEnabled: true, config, rootsToday: 0, llmCallsToday: 0 };
  const conv = { status: "open" as const, expiresAt: NOW_SEC + 3600, lastBotAt: NOW_SEC - 1200, replyCount: 0, unpromptedCount: 0 };

  it("stops on runtime OFF, disabled rule and LLM budget (CC-PATROL-06)", () => {
    expect(stopReason({ ...stop, runtimeDisabled: true }, true)).toMatch(/runtime/);
    expect(stopReason({ ...stop, ruleEnabled: false }, true)).toBe("rule disabled");
    expect(stopReason({ ...stop, llmCallsToday: 16 }, true)).toMatch(/llm budget/);
    expect(stopReason(stop, true)).toBeNull();
  });

  it("caps direct replies per conversation (CC-PATROL-07)", () => {
    expect(canReply(conv, config.followup, NOW_SEC).ok).toBe(true);
    expect(canReply({ ...conv, replyCount: 4 }, config.followup, NOW_SEC).reason).toMatch(/reply cap/);
    expect(canReply({ ...conv, expiresAt: NOW_SEC }, config.followup, NOW_SEC).reason).toBe("conversation closed");
  });

  it("follows up only after the wait, over a threshold, once", () => {
    const obs = { directRepliesSinceLastBot: 0, distinctReactors: 3, fineReactors: 3, badReactors: 0, laterHumanMessages: 0 };
    expect(evaluateFollowup(conv, obs, config.followup, NOW_SEC).ok).toBe(true);
    expect(evaluateFollowup({ ...conv, lastBotAt: NOW_SEC - 60 }, obs, config.followup, NOW_SEC).reason).toBe("min wait not elapsed");
    expect(evaluateFollowup({ ...conv, unpromptedCount: 1 }, obs, config.followup, NOW_SEC).reason).toMatch(/followup cap/);
    expect(evaluateFollowup(conv, { ...obs, distinctReactors: 2, fineReactors: 2 }, config.followup, NOW_SEC).reason).toBe("thresholds not met");
    expect(evaluateFollowup(conv, { ...obs, distinctReactors: 0, laterHumanMessages: 4 }, config.followup, NOW_SEC).ok).toBe(true);
    expect(evaluateFollowup(conv, { ...obs, badReactors: 2, fineReactors: 1 }, config.followup, NOW_SEC).reason).toBe("bad reactions dominant");
    expect(evaluateFollowup(conv, { ...obs, directRepliesSinceLastBot: 1 }, config.followup, NOW_SEC).ok).toBe(false);
  });
});

describe("choosePatrolAction priority", () => {
  const base: ChooseInput = {
    stop: { runtimeDisabled: false, ruleEnabled: true, config, rootsToday: 0, llmCallsToday: 0 },
    pendingReplies: [],
    pendingEventIds: [],
    followups: [],
    tickDue: false,
  };

  it("puts replies before events, followups and ticks", () => {
    const action = choosePatrolAction({
      ...base,
      pendingReplies: [
        { conversationId: "c1", inboundId: 10 },
        { conversationId: "c2", inboundId: 11 },
        { conversationId: "c1", inboundId: 12 },
      ],
      pendingEventIds: [5],
      followups: [{ conversationId: "c3", eligibility: { ok: true, reason: "x" } }],
      tickDue: true,
    });
    expect(action).toEqual({ kind: "reply", conversationId: "c1", inboundIds: [10, 12] });
  });

  it("batches at most three replies of the same conversation", () => {
    const replies = [1, 2, 3, 4].map((id) => ({ conversationId: "c", inboundId: id }));
    expect(choosePatrolAction({ ...base, pendingReplies: replies })).toMatchObject({ inboundIds: [1, 2, 3] });
  });

  it("orders event > followup > pick and skips with a reason", () => {
    expect(choosePatrolAction({ ...base, pendingEventIds: [9], tickDue: true })).toEqual({ kind: "event", eventId: 9 });
    expect(choosePatrolAction({ ...base, followups: [{ conversationId: "c", eligibility: { ok: true, reason: "r" } }], tickDue: true }).kind).toBe("followup");
    expect(choosePatrolAction({ ...base, tickDue: true })).toEqual({ kind: "pick" });
    expect(choosePatrolAction(base)).toEqual({ kind: "skip", reason: "no candidate" });
    expect(choosePatrolAction({ ...base, tickDue: true, stop: { ...base.stop, rootsToday: 8 } }).kind).toBe("skip");
  });

  it("returns stop before any work when stopped, even for replies", () => {
    const action = choosePatrolAction({
      ...base,
      stop: { ...base.stop, runtimeDisabled: true },
      pendingReplies: [{ conversationId: "c", inboundId: 1 }],
    });
    expect(action.kind).toBe("stop");
  });
});
