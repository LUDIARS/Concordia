import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSubsidiaryIntentInjection } from "./intent-inject.js";

describe("buildSubsidiaryIntentInjection", () => {
  let prevMode: string | undefined;
  beforeEach(() => {
    prevMode = process.env.CONCORDIA_PROMPT_ANALYZER;
    process.env.CONCORDIA_PROMPT_ANALYZER = "off"; // heuristic のみ (外部依存なし)
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.CONCORDIA_PROMPT_ANALYZER;
    else process.env.CONCORDIA_PROMPT_ANALYZER = prevMode;
  });

  it("heuristic 判定とハーネスルールを前置き文に含める", async () => {
    const out = await buildSubsidiaryIntentInjection({
      instruction: "Concordia に hook を追加してテストを回す",
      project: "concordia",
      rules: [{ kind: "block", title: "main 直 push 禁止", description: "変更はブランチ → PR 経由" }],
    });
    expect(out.result.source).toBe("heuristic");
    expect(out.preamble).toContain("ハーネス intent 判定");
    expect(out.preamble).toContain("判定: ");
    expect(out.preamble).toContain("[block] main 直 push 禁止: 変更はブランチ → PR 経由");
    expect(out.preamble).toContain("厳守して作業すること");
  });

  it("ルールが無くても注入文自体は生成される", async () => {
    const out = await buildSubsidiaryIntentInjection({
      instruction: "README を直したい",
      project: null,
      rules: [],
    });
    expect(out.preamble).toContain("ハーネス intent 判定");
    expect(out.preamble).not.toContain("適用ハーネスルール");
  });
});
