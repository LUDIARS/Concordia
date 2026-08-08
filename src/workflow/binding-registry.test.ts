import { describe, expect, it } from "vitest";
import { WorkflowBindingRegistry } from "./binding-registry.js";
import type { WorkflowKey } from "./keys.js";

function makeCountingBinding(key: WorkflowKey, name: string) {
  const calls = { started: 0, stopped: 0 };
  return {
    calls,
    binding: {
      key,
      name,
      start: () => {
        calls.started += 1;
        return { stop: () => { calls.stopped += 1; } };
      },
    },
  };
}

describe("WorkflowBindingRegistry", () => {
  it("有効なワークフローの binding だけ start する", () => {
    const enabled = new Set<WorkflowKey>(["task"]);
    const registry = new WorkflowBindingRegistry({ isEnabled: (key) => enabled.has(key) });
    const task = makeCountingBinding("task", "task-runtime");
    const cost = makeCountingBinding("cost", "cost-sampler");
    registry.register(task.binding);
    registry.register(cost.binding);

    registry.sync();

    expect(task.calls.started).toBe(1);
    expect(cost.calls.started).toBe(0);
    expect(registry.runningNames()).toEqual(["task-runtime"]);
  });

  it("sync は冪等 (有効なまま何度呼んでも二重起動しない)", () => {
    const registry = new WorkflowBindingRegistry({ isEnabled: () => true });
    const task = makeCountingBinding("task", "task-runtime");
    registry.register(task.binding);

    registry.sync();
    registry.sync();
    registry.sync();

    expect(task.calls.started).toBe(1);
  });

  it("有効→無効で stop し、 再度有効にすると張り直す", () => {
    const enabled = new Set<WorkflowKey>(["review"]);
    const registry = new WorkflowBindingRegistry({ isEnabled: (key) => enabled.has(key) });
    const review = makeCountingBinding("review", "pr-reconciler");
    registry.register(review.binding);

    registry.sync();
    expect(review.calls.started).toBe(1);
    expect(review.calls.stopped).toBe(0);

    enabled.delete("review");
    registry.sync();
    expect(review.calls.stopped).toBe(1);
    expect(registry.isRunning("pr-reconciler")).toBe(false);

    enabled.add("review");
    registry.sync();
    expect(review.calls.started).toBe(2);
    expect(registry.isRunning("pr-reconciler")).toBe(true);
  });

  it("stop() は稼働中の binding を全て止める", () => {
    const registry = new WorkflowBindingRegistry({ isEnabled: () => true });
    const task = makeCountingBinding("task", "task-runtime");
    const daily = makeCountingBinding("daily", "daily-scheduler");
    registry.register(task.binding);
    registry.register(daily.binding);
    registry.sync();

    registry.stop();

    expect(task.calls.stopped).toBe(1);
    expect(daily.calls.stopped).toBe(1);
    expect(registry.runningNames()).toEqual([]);
  });

  it("同名の binding は登録を拒否する", () => {
    const registry = new WorkflowBindingRegistry({ isEnabled: () => true });
    registry.register(makeCountingBinding("task", "dup").binding);
    expect(() => registry.register(makeCountingBinding("cost", "dup").binding)).toThrow(/duplicate/);
  });
});
