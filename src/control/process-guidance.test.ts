// @spec spec/feature/project-harness-policy.md
import { expect, it } from "vitest";
import { buildProcessGuidance, PROCESS_GUIDANCE_HEADER } from "./process-guidance.js";

const none = { ddd: false, tests: false, ontime: false, workContract: false };

it("stays silent when no requirement is enabled", () => {
  expect(buildProcessGuidance(null)).toBeNull();
  expect(buildProcessGuidance(none, "E:/fixture")).toBeNull();
});

it("keeps tests-only guidance free of DDD report and Anatomia commands", () => {
  const text = buildProcessGuidance({ ...none, tests: true }, "E:/fixture")!;
  expect(text).toContain("[Cc 必須プロセス]");
  expect(text).toContain("cc.acceptance.json");
  expect(text).not.toContain("DDD 対象の成果報告");
  expect(text).not.toContain("anatomia verify");
  expect(text).not.toContain("spec/domains");
});

it("lists the DDD steps in order and names the gate condition", () => {
  const text = buildProcessGuidance({ ...none, ddd: true }, "E:/fixture/")!;
  expect(text.startsWith(PROCESS_GUIDANCE_HEADER)).toBe(true);
  const order = ["1. 価値:", "2. 所属:", "3. 実装:", "4. 検証:", "5. 提出:"].map((label) => text.indexOf(label));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(text).toContain("E:/fixture/spec/domains/*.domain.json");
  expect(text).toContain("E:/fixture/spec/architecture/ddd.md");
  expect(text).toContain("deny");
  expect(text).not.toContain("契約:");
  expect(text).not.toContain("cc.acceptance.json");
});

it("adds the contract step and acceptance mapping when those settings are on", () => {
  const text = buildProcessGuidance({ ddd: true, workContract: true, tests: true, ontime: false }, "E:/fixture")!;
  expect(text.indexOf("契約:")).toBeGreaterThan(text.indexOf("所属:"));
  expect(text.indexOf("契約:")).toBeLessThan(text.indexOf("実装:"));
  expect(text).toContain("人間の開始指示が無い実装は進めない");
  expect(text).toContain("Actio task");
  expect(text).toContain("E:/fixture/cc.acceptance.json");
  expect(text).not.toContain("augur.contracts.json");
  expect(buildProcessGuidance({ ...none, ontime: true })!).toContain("augur.contracts.json");
});

it("never grants execution permission", () => {
  const text = buildProcessGuidance({ ddd: true, workContract: true, tests: true, ontime: true })!;
  expect(text).toContain("許可範囲");
  expect(text).not.toMatch(/テストを実行してよい|再起動してよい/);
});
