import { describe, expect, it } from "vitest";
import type { DomainReviewReport } from "../domain-review/types.js";
import { buildDomainReviewEmbeds } from "./domain-review-embeds.js";
import { EMBED_LIMITS, totalCharacters } from "./embed-limits.js";

function report(overrides: Partial<DomainReviewReport> = {}): DomainReviewReport {
  return {
    target: { code: "Cc", project: "Concordia", repoPath: "E:/Document/Ars/Concordia" },
    trigger: "manual",
    source: "prepared",
    anatomiaProjectId: "concordia",
    coreDomains: [],
    relations: [],
    unlinkedProgramDomains: [],
    layers: [],
    layerViolations: [],
    unclassifiedModules: [],
    planQuestions: [],
    planTaskHash: null,
    notes: [],
    ...overrides,
  };
}

function coreDomain(name: string, purpose: string, uxCritical = false) {
  return {
    id: name,
    name,
    purpose,
    status: "implemented",
    uxCritical,
    parentId: null,
    childIds: [],
    implementorCount: null,
    violationCount: null,
  };
}

describe("buildDomainReviewEmbeds", () => {
  it("コアドメインと層で 2 枚、plan の問いがあれば 3 枚", () => {
    expect(buildDomainReviewEmbeds(report())).toHaveLength(2);
    expect(buildDomainReviewEmbeds(report({
      planQuestions: ["問い"],
      planTaskHash: "0123456789abcdef",
    }))).toHaveLength(3);
  });

  it("ドメインが 200 件でも Discord の上限を 1 つも超えない", () => {
    const embeds = buildDomainReviewEmbeds(report({
      coreDomains: Array.from({ length: 200 }, (_, i) =>
        coreDomain(`domain-${i}`, `${"とても長い説明文".repeat(20)}`, i % 3 === 0)),
      relations: Array.from({ length: 200 }, (_, i) => ({
        from: `domain-${i}`,
        to: `domain-${(i + 1) % 200}`,
        relation: "depends-on",
        rationale: "理由".repeat(80),
      })),
      layers: Array.from({ length: 40 }, (_, i) => ({
        layer: `layer-${i}`,
        domains: Array.from({ length: 50 }, (_, j) => ({
          id: `domain-${i}-${j}`,
          cohesion: 0.5,
          misfitCount: j % 2,
        })),
      })),
      layerViolations: Array.from({ length: 200 }, (_, i) => ({
        from: `a-${i}`,
        to: `b-${i}`,
        weight: i,
      })),
      unclassifiedModules: Array.from({ length: 200 }, (_, i) => `src/mod-${i}`),
      planQuestions: Array.from({ length: 100 }, (_, i) => `問い ${i} ${"詳細".repeat(50)}`),
      planTaskHash: "0123456789abcdef",
    }));

    expect(embeds.length).toBeLessThanOrEqual(EMBED_LIMITS.embedsPerMessage);
    expect(totalCharacters(embeds)).toBeLessThanOrEqual(EMBED_LIMITS.totalCharacters);
    expect(embeds.some((embed) => embed.title?.startsWith("❓ plan"))).toBe(true);
    expect(embeds.flatMap((embed) => embed.fields ?? [])
      .some((field) => field.name.startsWith("問い") && field.value.includes("問い 0"))).toBe(true);
    for (const embed of embeds) {
      expect((embed.title ?? "").length).toBeLessThanOrEqual(EMBED_LIMITS.title);
      expect((embed.description ?? "").length).toBeLessThanOrEqual(EMBED_LIMITS.description);
      expect((embed.fields ?? []).length).toBeLessThanOrEqual(EMBED_LIMITS.fieldsPerEmbed);
      for (const field of embed.fields ?? []) {
        expect(field.name.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldName);
        expect(field.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
      }
    }
  });

  it("Anatomia 由来のテキストに含まれるメンションは発火しない形になる", () => {
    const embeds = buildDomainReviewEmbeds(report({
      coreDomains: [coreDomain("evil", "@everyone このドメインを見て <@123456789012345678>")],
      planQuestions: ["@here 判断してほしい"],
      planTaskHash: "0123456789abcdef",
      notes: ["@everyone 注意"],
    }));
    const serialized = JSON.stringify(embeds);
    expect(serialized).not.toContain("@everyone");
    expect(serialized).not.toContain("@here");
    expect(serialized).not.toContain("<@123456789012345678>");
  });

  it("未 prepare は本文でそう告げる", () => {
    const embeds = buildDomainReviewEmbeds(report({
      source: "raw",
      coreDomains: [coreDomain("governance", "")],
      notes: ["prepare してください"],
    }));
    expect(embeds[0]!.description).toContain("未 prepare");
    expect(embeds[0]!.description).toContain("prepare してください");
  });

  it("層違反が無いことは「なし」と明示する (欄ごと消さない)", () => {
    const embeds = buildDomainReviewEmbeds(report({
      layers: [{ layer: "application", domains: [{ id: "x", cohesion: null, misfitCount: 0 }] }],
    }));
    const field = embeds[1]!.fields!.find((f) => f.name.startsWith("層違反依存"));
    expect(field?.value).toBe("なし");
  });

  it("件数上限で表示しきれない短い項目も省略件数を明示する", () => {
    const embeds = buildDomainReviewEmbeds(report({
      coreDomains: Array.from({ length: 200 }, (_, i) => coreDomain(`d${i}`, "")),
      relations: Array.from({ length: 200 }, (_, i) => ({
        from: `d${i}`,
        to: `d${i + 1}`,
        relation: "uses",
        rationale: "",
      })),
      layerViolations: Array.from({ length: 200 }, (_, i) => ({ from: `a${i}`, to: `b${i}`, weight: 1 })),
    }));
    const core = embeds[0]!.fields!.find((field) => field.name.startsWith("コアドメイン"));
    const relations = embeds[0]!.fields!.find((field) => field.name.startsWith("関係辺"));
    const violations = embeds[1]!.fields!.find((field) => field.name.startsWith("層違反依存"));
    expect(core?.value).toMatch(/以下省略 \(\d+ 件\)/);
    expect(relations?.value).toMatch(/以下省略 \(\d+ 件\)/);
    expect(violations?.value).toMatch(/以下省略 \(\d+ 件\)/);
  });
});
