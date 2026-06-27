import { describe, it, expect } from "vitest";
import { priceForModel } from "./price-table.js";

describe("priceForModel", () => {
  it("current Opus (4.5〜4.8) は $5/$25", () => {
    for (const m of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"]) {
      expect(priceForModel(m)).toEqual({ inputPerMtok: 5, outputPerMtok: 25 });
    }
  });
  it("Sonnet 4.x は $3/$15、 Haiku 4.5 は $1/$5", () => {
    expect(priceForModel("claude-sonnet-4-6")).toEqual({ inputPerMtok: 3, outputPerMtok: 15 });
    expect(priceForModel("claude-haiku-4-5")).toEqual({ inputPerMtok: 1, outputPerMtok: 5 });
  });
  it("Fable 5 / Mythos は $10/$50", () => {
    expect(priceForModel("claude-fable-5")).toEqual({ inputPerMtok: 10, outputPerMtok: 50 });
    expect(priceForModel("claude-mythos-5")).toEqual({ inputPerMtok: 10, outputPerMtok: 50 });
  });
  it("legacy Opus (4 / 4.1) は $15/$75", () => {
    expect(priceForModel("claude-opus-4-1")).toEqual({ inputPerMtok: 15, outputPerMtok: 75 });
    expect(priceForModel("claude-opus-4-0")).toEqual({ inputPerMtok: 15, outputPerMtok: 75 });
  });
  it("大文字小文字を無視する", () => {
    expect(priceForModel("Claude-Opus-4-8")).toEqual({ inputPerMtok: 5, outputPerMtok: 25 });
  });
  it("未知 (codex/gpt) / 空 は null (誤った単価を当てない)", () => {
    expect(priceForModel("gpt-5-codex")).toBeNull();
    expect(priceForModel("o4-mini")).toBeNull();
    expect(priceForModel(null)).toBeNull();
    expect(priceForModel("")).toBeNull();
  });
});
