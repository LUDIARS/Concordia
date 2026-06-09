import { describe, it, expect } from "vitest";
import {
  classifyReactionWorkflow,
  planWorkflow,
  type WorkflowContext,
} from "./reaction-workflow.js";

const baseCtx: WorkflowContext = {
  messageText: "新しいキャッシュ層を入れる提案。LRU で 1000 件、TTL 5 分。",
  authorLabel: "設計担当",
  repoPath: "E:/Document/Ars/Memoria",
  sessionActive: true,
  memoriaPath: "E:/Document/Ars/Memoria",
  reactorId: "u123",
};

describe("classifyReactionWorkflow", () => {
  it.each([
    ["👍", "start-impl"],
    ["🆗", "start-impl"],
    ["😄", "repo-memory-good"],
    ["😀", "repo-memory-good"],
    ["👀", "memoria-note"],
    ["📝", "memoria-task"],
    ["✅", "memoria-task"],
    ["✔️", "memoria-task"],
    ["😡", "repo-memory-bad"],
    ["👎", "repo-memory-bad"],
  ] as const)("maps %s → %s", (emoji, action) => {
    expect(classifyReactionWorkflow(emoji)).toBe(action);
  });

  it("returns null for unmapped emoji", () => {
    expect(classifyReactionWorkflow("🎉")).toBeNull();
    expect(classifyReactionWorkflow("🍕")).toBeNull();
  });

  it("ignores surrounding whitespace", () => {
    expect(classifyReactionWorkflow(" 👍 ")).toBe("start-impl");
  });
});

describe("planWorkflow", () => {
  it("start-impl on active session → inject (no headless)", () => {
    const plan = planWorkflow("start-impl", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("実装");
  });

  it("start-impl on inactive session → headless in repo cwd", () => {
    const plan = planWorkflow("start-impl", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.cwd).toBe(baseCtx.repoPath);
  });

  it("repo-memory-good → headless haiku in repo cwd, embeds message", () => {
    const plan = planWorkflow("repo-memory-good", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("haiku");
    expect(plan.cwd).toBe(baseCtx.repoPath);
    expect(plan.prompt).toContain("作業メモリ");
    expect(plan.prompt).toContain("キャッシュ層");
  });

  it("repo-memory-bad → headless haiku, framed as avoid-pattern", () => {
    const plan = planWorkflow("repo-memory-bad", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("haiku");
    expect(plan.prompt).toContain("良くない");
  });

  it("memoria-note → headless haiku in Memoria cwd", () => {
    const plan = planWorkflow("memoria-note", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("haiku");
    expect(plan.cwd).toBe(baseCtx.memoriaPath);
    expect(plan.prompt).toContain("Memoria");
  });

  it("memoria-task → headless sonnet in Memoria cwd", () => {
    const plan = planWorkflow("memoria-task", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.memoriaPath);
    expect(plan.prompt).toContain("タスク");
  });

  it("honors custom model overrides", () => {
    const plan = planWorkflow("memoria-task", baseCtx, { haiku: "h", sonnet: "claude-sonnet-4-6" });
    expect(plan.model).toBe("claude-sonnet-4-6");
  });
});
