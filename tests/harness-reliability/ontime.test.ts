import { describe, expect, it, vi } from "vitest";
import { contract, type ContractSpec } from "../../src/harness/reliability/ontime-runtime.js";
import sampling from "../../src/harness/reliability/contracts/sampling.contract.js";
import { observeToolFollowup } from "../../src/harness/reliability/tool-followup.js";
import { emptyState } from "../../src/harness/reliability/state.js";
import { workflowGuidance } from "../../src/harness/reliability/workflow-guidance.js";

const spec: ContractSpec = { contractId: "fixture", id: "12345678", rule: "contract-wrap", where: "fixture:1", mode: "observe", sample: 1 };
describe("observe-only contracts", () => {
  it("detects a budget violation without changing the returned value or exposing input", () => {
    const sink = vi.fn();
    const wrapped = contract(() => true, { ...spec, ...sampling }, sink);
    expect((wrapped as Function)({ count: 20, samples: 12, slot: 1, lastSlot: 0, secret: "never-log-me" })).toBe(true);
    expect(sink.mock.calls[0][0]).toBe("contract violated");
    expect(JSON.stringify(sink.mock.calls)).not.toContain("never-log-me");
  });
  it("preserves thrown identity and tolerates failed predicates and sink", async () => {
    const error = new Error("private");
    const sink = vi.fn(() => { throw new Error("sink unavailable"); });
    const wrapped = contract(async () => { throw error; }, { ...spec, pre: () => { throw error; } }, sink);
    await expect(wrapped()).rejects.toBe(error);
    expect(sink).toHaveBeenCalled();
  });
  it("preserves receiver and async result while recording one satisfied call", async () => {
    const sink = vi.fn();
    const object = { value: 7, fn: contract(async function (this: { value: number }) { return this.value; }, { ...spec, post: value => value === 7 }, sink) };
    expect(await object.fn()).toBe(7);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toBe("contract observed");
  });
});
describe("workflow follow-up", () => {
  it("keeps automatic packets out and documents the unregistered Pf fallback", () => {
    expect(workflowGuidance("[自動確認] 機能の実装を調査")).toEqual([]);
    expect(workflowGuidance("この機能の実装を調査して")[0].advice).toContain("未登録");
  });
  it("deduplicates hook replay and warns only on the third actual failure", () => {
    const state = emptyState();
    const input = { event_id: "1", tool: "Bash", failed: true, code: "EPERM" };
    expect(observeToolFollowup(state, input, 1)).toBe("");
    expect(observeToolFollowup(state, input, 2)).toBe("");
    expect(observeToolFollowup(state, { ...input, event_id: "2" }, 3)).toBe("");
    expect(observeToolFollowup(state, { ...input, event_id: "3" }, 4)).toContain("3回");
  });
  it("does not equate recommended tools or later reads with completed writes", () => {
    const state = emptyState();
    expect(observeToolFollowup(state, { event_id: "1", tool: "mcp__actio__create_task", failed: true, code: "ETIMEDOUT" }, 1)).toContain("結果が不明");
    observeToolFollowup(state, { event_id: "2", tool: "mcp__actio__get_task", failed: false }, 2);
    expect(state.observations.mutation_result.status).toBe("unknown");
    expect(state.observations.tool_use_actio.status).toBe("successful_call_observed");
  });
});
