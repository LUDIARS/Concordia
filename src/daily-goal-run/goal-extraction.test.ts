import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, createLlmGoalExtraction, parseExtractionOutput } from "./goal-extraction.js";

describe("LLM goal extraction (2. 読み取り)", () => {
  it("asks for quotes and forbids inventing acceptance criteria", () => {
    const prompt = buildExtractionPrompt("Cc を出荷する");
    expect(prompt).toContain("quotes");
    expect(prompt).toContain("受入条件をゴール文から推測して作ってはいけません");
    expect(prompt).toContain("Cc を出荷する");
  });

  it("parses the JSON reply and treats non-true permissions as denied", () => {
    const parsed = parseExtractionOutput('前置き {"project":"Cc","goalText":"出荷","acceptance":["A",""],"permissions":{"merge":"yes","test":true},"actioTaskIds":["t1"],"quotes":{"project":"Cc","x":1}}');
    expect(parsed).toEqual({ project: "Cc", goalText: "出荷", acceptance: ["A"], actioTaskIds: ["t1"],
      permissions: { merge: false, test: true, service: false, deploy: false }, quotes: { project: "Cc" } });
    expect(parseExtractionOutput("JSON ではない")).toBeNull();
  });

  it("uses a timeout of at least 60 seconds and reports failures instead of guessing", async () => {
    const seen: number[] = [];
    const failing = createLlmGoalExtraction(async (_prompt, opts) => { seen.push(opts.timeoutMs); return { ok: false, stdout: "" }; }, { timeoutMs: 10_000 });
    expect(await failing.extract("x")).toMatchObject({ ok: false });
    expect(seen[0]).toBeGreaterThanOrEqual(60_000);
    const throwing = createLlmGoalExtraction(async () => { throw new Error("spawn failed"); });
    expect(await throwing.extract("x")).toMatchObject({ ok: false });
    const working = createLlmGoalExtraction(async () => ({ ok: true, stdout: '{"goalText":"出荷","quotes":{"goalText":"出荷"}}' }));
    expect(await working.extract("出荷")).toMatchObject({ ok: true, extracted: { goalText: "出荷", acceptance: [] } });
  });
});
