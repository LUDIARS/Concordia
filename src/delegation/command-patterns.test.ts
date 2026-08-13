import { describe, expect, it, vi } from "vitest";
import type { GeniusCard, GeniusClient } from "../inquiry/genius-client.js";
import { buildCommandPatternBlock, COMMAND_PATTERN_CATEGORY } from "./command-patterns.js";

function card(overrides: Partial<GeniusCard> = {}): GeniusCard {
  return {
    id: overrides.id ?? "card-1",
    title: overrides.title ?? "定型作業",
    score: overrides.score ?? 0.9,
    category: overrides.category ?? COMMAND_PATTERN_CATEGORY,
    situation: overrides.situation,
    judgment: overrides.judgment ?? "npm run example",
    rationale: overrides.rationale,
  };
}

describe("buildCommandPatternBlock", () => {
  it("queries only command-pattern cards and renders the two highest valid matches", async () => {
    const query = vi.fn(async () => [
      card({ id: "low", title: "低スコア", score: 0.5 }),
      card({ id: "second", title: "二位", score: 0.8, judgment: "second command" }),
      card({ id: "wrong", title: "別カテゴリ", score: 1, category: "設計判断" }),
      card({ id: "first", title: "一位", score: 0.9, judgment: "first command" }),
      card({ id: "third", title: "三位", score: 0.7, judgment: "third command" }),
    ]);
    const genius: GeniusClient = { query };

    const block = await buildCommandPatternBlock({ genius, scoreMin: 0.6 }, "  task text  ");
    if (!block) throw new Error("expected command pattern block");

    expect(query).toHaveBeenCalledWith({
      text: "task text",
      categories: [COMMAND_PATTERN_CATEGORY],
      k: 4,
    });
    expect(block).toContain("## コマンドパターン (Genius)");
    expect(block).toContain("### 一位\n\nfirst command");
    expect(block).toContain("### 二位\n\nsecond command");
    expect(block.indexOf("### 一位")).toBeLessThan(block.indexOf("### 二位"));
    expect(block).not.toContain("低スコア");
    expect(block).not.toContain("別カテゴリ");
    expect(block).not.toContain("三位");
  });

  it("does not let an empty judgment consume one of the two result slots", async () => {
    const genius: GeniusClient = {
      query: async () => [
        card({ id: "empty", score: 1, judgment: "   " }),
        card({ id: "first", title: "有効1", score: 0.9 }),
        card({ id: "second", title: "有効2", score: 0.8 }),
      ],
    };

    const block = await buildCommandPatternBlock({ genius, scoreMin: 0.6 }, "task");
    if (!block) throw new Error("expected command pattern block");

    expect(block).toContain("### 有効1");
    expect(block).toContain("### 有効2");
  });

  it("keeps the complete block within 6000 characters and can use a later fitting card", async () => {
    const genius: GeniusClient = {
      query: async () => [
        card({ id: "oversized", score: 1, judgment: "x".repeat(6_000) }),
        card({ id: "fitting", title: "採用", score: 0.9, judgment: "short command" }),
      ],
    };

    const block = await buildCommandPatternBlock({ genius, scoreMin: 0.6 }, "task");
    if (!block) throw new Error("expected command pattern block");

    expect(block).toContain("### 採用");
    expect(block).not.toContain("x".repeat(100));
    expect(block.length).toBeLessThanOrEqual(6_000);
  });

  it("does not query Genius for an empty task", async () => {
    const query = vi.fn(async () => [card()]);
    const genius: GeniusClient = { query };

    await expect(buildCommandPatternBlock({ genius, scoreMin: 0.6 }, "   ")).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("limits the Genius query text to the first 2000 characters", async () => {
    const query = vi.fn<GeniusClient["query"]>(async () => []);
    const genius: GeniusClient = { query };

    await buildCommandPatternBlock({ genius, scoreMin: 0.6 }, "x".repeat(2_001));

    expect(query.mock.calls[0]?.[0].text).toHaveLength(2_000);
  });
});
