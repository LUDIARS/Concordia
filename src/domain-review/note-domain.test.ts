import { describe, expect, it } from "vitest";
import {
  buildNoteDomainChoices,
  MAX_NOTE_DOMAIN_CHOICES,
  NOTE_DOMAIN_PROJECT_WIDE,
  parseNoteDomainChoice,
  resolveNoteDomain,
} from "./note-domain.js";

const domains = [
  { id: "combat", name: "Combat" },
  { id: "inventory", name: "Inventory" },
];

describe("resolveNoteDomain", () => {
  it("先頭のドメイン名と半角コロンで決まり、本文から指定部分を外す", () => {
    expect(resolveNoteDomain("combat: ダメージ計算は武器側", domains))
      .toEqual({ kind: "domain", domainId: "combat", note: "ダメージ計算は武器側" });
  });

  it("大小・前後空白・全角コロンを吸収する", () => {
    expect(resolveNoteDomain("  INVENTORY ：  所持上限は 99", domains))
      .toEqual({ kind: "domain", domainId: "inventory", note: "所持上限は 99" });
  });

  it("知らない名前・区切り無し・本文空は未決", () => {
    expect(resolveNoteDomain("magic: 詠唱", domains)).toEqual({ kind: "unresolved" });
    expect(resolveNoteDomain("combat のダメージ計算", domains)).toEqual({ kind: "unresolved" });
    expect(resolveNoteDomain("combat:   ", domains)).toEqual({ kind: "unresolved" });
  });

  it("複数のドメインに一致する指定は推測せず未決", () => {
    const ambiguous = [{ id: "a", name: "shared" }, { id: "b", name: "Shared" }];
    expect(resolveNoteDomain("shared: どちら?", ambiguous)).toEqual({ kind: "unresolved" });
  });
});

describe("buildNoteDomainChoices", () => {
  it("名前順のドメインの後ろにプロジェクト全体を置く", () => {
    const result = buildNoteDomainChoices([...domains].reverse());
    expect(result.choices.map((choice) => choice.value)).toEqual(["combat", "inventory", NOTE_DOMAIN_PROJECT_WIDE]);
    expect(result.omitted).toBe(0);
  });

  it("25 件上限を超えるドメインは先頭 24 件に絞り、省略数を返す", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `d${String(index).padStart(2, "0")}`,
      name: `d${String(index).padStart(2, "0")}`,
    }));
    const result = buildNoteDomainChoices(many);
    expect(result.choices).toHaveLength(MAX_NOTE_DOMAIN_CHOICES + 1);
    expect(result.omitted).toBe(30 - MAX_NOTE_DOMAIN_CHOICES);
  });

  it("ドメインが無くてもプロジェクト全体だけは選べる", () => {
    expect(buildNoteDomainChoices([]).choices.map((choice) => choice.value)).toEqual([NOTE_DOMAIN_PROJECT_WIDE]);
  });
});

describe("parseNoteDomainChoice", () => {
  it("プロジェクト全体は null、ドメインは id、空は不正", () => {
    expect(parseNoteDomainChoice(NOTE_DOMAIN_PROJECT_WIDE)).toBeNull();
    expect(parseNoteDomainChoice("combat")).toBe("combat");
    expect(parseNoteDomainChoice("  ")).toBeUndefined();
  });
});
