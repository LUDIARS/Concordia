import { describe, expect, it } from "vitest";
import { contractModelOverrides } from "./delegation-model-scope.js";

const value = <T,>(v: T) => ({ value: v, decided_by: "seed" as const, rationale: "test", genius_card_ids: [] });
const claudeContract = { model: value("claude-opus-5-5"), effort: value("max") };
const codexContract = { model: value("gpt-6-astra"), effort: value("medium") };

describe("contractModelOverrides", () => {
  it("applies the contract to a delegation of the same provider family", () => {
    expect(contractModelOverrides(claudeContract, "claude-code", "claude", { model: "x", reasoning_effort: "low" }))
      .toEqual({ model: "claude-opus-5-5", reasoning_effort: "max" });
    expect(contractModelOverrides(codexContract, "codex-cli", "codex", undefined))
      .toEqual({ model: "gpt-6-astra", reasoning_effort: "medium" });
  });

  it("does not push a Claude contract onto a Codex delegation (Actio 042b0e71)", () => {
    expect(contractModelOverrides(claudeContract, "claude-code", "codex", undefined))
      .toEqual({ model: undefined, reasoning_effort: undefined });
    expect(contractModelOverrides(claudeContract, "claude-code", "codex-sdk", { model: "gpt-6-astra" }))
      .toEqual({ model: "gpt-6-astra", reasoning_effort: undefined });
  });

  it("keeps the caller's request when either side's family is unknown", () => {
    expect(contractModelOverrides(claudeContract, null, "claude", { reasoning_effort: "high" }))
      .toEqual({ model: undefined, reasoning_effort: "high" });
    expect(contractModelOverrides(codexContract, "codex-cli", "gemma4-12", undefined))
      .toEqual({ model: undefined, reasoning_effort: undefined });
  });

  it("falls back to the request for a field the contract leaves undecided", () => {
    expect(contractModelOverrides({ model: null, effort: value("high") }, "claude-code", "claude", { model: "claude-sonnet-5-5" }))
      .toEqual({ model: "claude-sonnet-5-5", reasoning_effort: "high" });
    expect(contractModelOverrides(null, "claude-code", "claude", { model: "m" }))
      .toEqual({ model: "m", reasoning_effort: undefined });
  });
});
