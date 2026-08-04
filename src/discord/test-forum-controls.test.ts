import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEST_RUN_CONFIG,
  buildTestControlId,
  describeRunConfig,
  isEffortSupported,
  parseProviderChoice,
  parseTestControlId,
  providerChoiceValue,
  testControlLayout,
  testEffortChoices,
} from "./test-forum-controls.js";

describe("test forum controls", () => {
  it("defaults to Codex Sol at xhigh", () => {
    // neco 指定: 見落とさないことが価値なので既定は最も強い設定。
    expect(DEFAULT_TEST_RUN_CONFIG).toEqual({ provider: "codex", model: "sol", effort: "xhigh" });
  });

  it("turns the start button into the merge button once testing began", () => {
    expect(testControlLayout("candidate")).toEqual({
      primary: { action: "start", label: "テスト開始", style: "primary" },
      selectors: true,
    });
    expect(testControlLayout("testing")).toEqual({
      primary: { action: "merge", label: "マージ", style: "success" },
      selectors: false,
    });
    // マージ済みには操作を出さない (二重マージの入口を残さない)。
    expect(testControlLayout("merged")).toEqual({ primary: null, selectors: false });
  });

  it("round-trips control ids", () => {
    expect(parseTestControlId(buildTestControlId("start", 42)))
      .toEqual({ action: "start", surfaceId: 42 });
    expect(parseTestControlId(buildTestControlId("merge", 7)))
      .toEqual({ action: "merge", surfaceId: 7 });
  });

  it("rejects ids that are not ours or carry no usable surface", () => {
    expect(parseTestControlId("ctrl:spawn:1")).toBeNull();
    expect(parseTestControlId("test:start")).toBeNull();
    expect(parseTestControlId("test:explode:1")).toBeNull();
    expect(parseTestControlId("test:start:0")).toBeNull();
    expect(parseTestControlId("test:start:abc")).toBeNull();
    expect(parseTestControlId("test:start:1e3")).toBeNull();
    expect(parseTestControlId("test:start: 1")).toBeNull();
  });

  it("round-trips provider choices and falls back to the default", () => {
    expect(parseProviderChoice("claude:opus"))
      .toEqual({ provider: "claude", model: "opus", effort: "high" });
    expect(providerChoiceValue({ provider: "codex", model: "sol", effort: "xhigh" }))
      .toBe("codex:sol");
    // 未知値でセッションを起動させない (選択肢が増減しても既定へ落ちる)。
    expect(parseProviderChoice("gemini:pro")).toEqual(DEFAULT_TEST_RUN_CONFIG);
  });

  it("validates effort before it reaches a spawn argument", () => {
    expect(isEffortSupported("codex", "xhigh")).toBe(true);
    expect(isEffortSupported("codex", "ultra")).toBe(false);
  });

  it("offers only the effort values the chosen provider actually honors", () => {
    // Claude Code の effort 語彙に minimal は無い。 選ばせると spawn 時に黙って
    // 捨てられ、 投稿の表示と実行設定が食い違う。
    expect(testEffortChoices("codex")).toContain("minimal");
    expect(testEffortChoices("claude")).not.toContain("minimal");
    expect(isEffortSupported("claude", "minimal")).toBe(false);
    expect(isEffortSupported("claude", "xhigh")).toBe(true);
    expect(isEffortSupported("codex", "minimal")).toBe(true);
  });

  it("shows the effective configuration in the post", () => {
    expect(describeRunConfig({ provider: "codex", model: "sol", effort: "xhigh" }))
      .toContain("codex/sol");
    expect(describeRunConfig({ provider: "codex", model: "", effort: "low" }))
      .toContain("`codex`");
  });
});
