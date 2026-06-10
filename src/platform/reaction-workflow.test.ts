import { describe, it, expect } from "vitest";
import {
  classifyReactionWorkflow,
  defaultReactionEmojiMap,
  isWorkflowAction,
  planWorkflow,
  WORKFLOW_ACTIONS,
  WORKFLOW_ACTION_HELP,
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
    ["🙏", "enumerate-remaining"],
    ["🫡", "memoria-remaining"],
    ["📲", "status-check"],
    ["🆙", "status-check"],
    ["👆", "status-check"],
    ["😄", "repo-memory-good"],
    ["😀", "repo-memory-good"],
    ["👀", "memoria-note"],
    ["👈", "memoria-note"],
    ["📓", "memoria-note"],
    ["✏️", "memoria-note"],
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

  it("custom overrides take precedence over defaults; add new emoji", () => {
    const overrides = { "👍": "memoria-note" as const, "🔥": "start-impl" as const };
    expect(classifyReactionWorkflow("👍", overrides)).toBe("memoria-note"); // 上書き
    expect(classifyReactionWorkflow("🔥", overrides)).toBe("start-impl");   // 新規
    expect(classifyReactionWorkflow("🫡", overrides)).toBe("memoria-remaining"); // 上書きなし=既定
    expect(classifyReactionWorkflow("🎉", overrides)).toBeNull();
  });
});

describe("defaultReactionEmojiMap / isWorkflowAction", () => {
  it("flattens defaults and every value is a valid action", () => {
    const map = defaultReactionEmojiMap();
    expect(map["🙏"]).toBe("enumerate-remaining");
    expect(map["🫡"]).toBe("memoria-remaining");
    expect(map["📲"]).toBe("status-check");
    for (const action of Object.values(map)) expect(isWorkflowAction(action)).toBe(true);
  });

  it("isWorkflowAction rejects unknown strings", () => {
    expect(isWorkflowAction("start-impl")).toBe(true);
    expect(isWorkflowAction("nope")).toBe(false);
    expect(isWorkflowAction(123)).toBe(false);
  });
});

describe("WORKFLOW_ACTION_HELP", () => {
  it("has label/summary/mode for every action", () => {
    for (const a of WORKFLOW_ACTIONS) {
      const h = WORKFLOW_ACTION_HELP[a];
      expect(h.label.length).toBeGreaterThan(0);
      expect(h.summary).toContain("変換"); // 「投稿内容を変換して渡す」を明示
      expect(h.mode.length).toBeGreaterThan(0);
    }
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

  it("enumerate-remaining on active session → inject (残作業洗い出し)", () => {
    const plan = planWorkflow("enumerate-remaining", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("残作業");
  });

  it("enumerate-remaining on inactive session → headless sonnet in repo cwd", () => {
    const plan = planWorkflow("enumerate-remaining", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.repoPath);
  });

  it("memoria-remaining → headless sonnet in Memoria cwd (残作業記録)", () => {
    const plan = planWorkflow("memoria-remaining", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.memoriaPath);
    expect(plan.prompt).toContain("残作業");
    expect(plan.prompt).toContain("Memoria");
  });

  it("status-check on active session → inject (状況報告)", () => {
    const plan = planWorkflow("status-check", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("状況");
  });

  it("status-check on inactive session → headless sonnet in repo cwd", () => {
    const plan = planWorkflow("status-check", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.cwd).toBe(baseCtx.repoPath);
  });

  it("inject prompts embed the converted posted message (投稿内容を変換して渡す)", () => {
    for (const action of ["start-impl", "enumerate-remaining", "status-check"] as const) {
      const plan = planWorkflow(action, { ...baseCtx, sessionActive: true });
      expect(plan.mode).toBe("inject");
      expect(plan.prompt).toContain("対象メッセージ");
      expect(plan.prompt).toContain("キャッシュ層"); // baseCtx.messageText の一部
    }
  });

  it("honors custom model overrides", () => {
    const plan = planWorkflow("memoria-task", baseCtx, { haiku: "h", sonnet: "claude-sonnet-4-6" });
    expect(plan.model).toBe("claude-sonnet-4-6");
  });
});
