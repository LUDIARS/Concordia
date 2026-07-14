import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import { DelegationEffortBlackbox } from "./effort-blackbox.js";

describe("DelegationEffortBlackbox", () => {
  it("learns a repeated LLM judgement and later decides by rule", async () => {
    const db = makeTestDb();
    let calls = 0;
    const runClaude: RunClaudeFn = async () => {
      calls += 1;
      return { ok: true, stdout: '{"effort":"medium","confidence":0.88,"rationale":"normal implementation"}', stderr: "" };
    };
    const box = new DelegationEffortBlackbox(db, runClaude);
    const input = {
      provider: "codex" as const,
      model: "gpt-5.5",
      prompt: "Implement the API endpoint and tests.",
      callName: "impl",
      project: "Concordia",
    };

    for (let index = 0; index < 4; index += 1) await box.decide(input);
    const learned = await box.decide(input);
    expect(learned).toMatchObject({ level: "medium", bucket: "implementation", source: "blackbox-rule" });
    expect(calls).toBe(4);
    expect(box.stats().ruleCoverage).toBeGreaterThan(0);
  });

  it("falls back deterministically when the LLM judge is unavailable", async () => {
    const runClaude: RunClaudeFn = async () => ({ ok: false, stdout: "", stderr: "offline" });
    const box = new DelegationEffortBlackbox(makeTestDb(), runClaude);
    const decision = await box.decide({
      provider: "claude",
      model: null,
      prompt: "Investigate the race condition and redesign the architecture.",
      callName: "design",
      project: null,
    });
    expect(decision).toMatchObject({ level: "xhigh", bucket: "complex", source: "blackbox-fallback" });
    expect(box.recordOutcome(decision.decision_id, "failed").ok).toBe(true);
  });
});
