import { describe, expect, it } from "vitest";
import {
  extractDelegatedTaskLabel,
  projectDelegatedChildRun,
} from "./status-card-projection.js";

describe("extractDelegatedTaskLabel", () => {
  it("uses known human-readable task arguments in priority order", () => {
    expect(extractDelegatedTaskLabel(JSON.stringify({
      problem: "Fallback problem",
      task: "  Implement   the child card\nprojection ",
      prompt: "complete rendered prompt must not appear",
    }), "impl")).toBe("Implement the child card projection");
  });

  it("does not render unknown prompt arguments or secrets", () => {
    expect(extractDelegatedTaskLabel(JSON.stringify({
      prompt: "complete prompt with private details",
      notes: "Bearer top-secret-token",
    }), "safe-call-name")).toBe("safe-call-name");
    expect(extractDelegatedTaskLabel(JSON.stringify({
      task: "Debug token=abc123 and Bearer secret-value with sk-1234567890abcdef",
    }), "impl")).toBe(
      "Debug token=[REDACTED] and Bearer [REDACTED] with [REDACTED]",
    );
  });

  it("handles malformed JSON and truncates by Unicode code point", () => {
    expect(extractDelegatedTaskLabel("{broken", "fallback")).toBe("fallback");
    const label = extractDelegatedTaskLabel(JSON.stringify({ task: `🧭${"x".repeat(300)}` }), "impl");
    expect([...label]).toHaveLength(180);
    expect(label.endsWith("...")).toBe(true);
    expect(label.startsWith("🧭")).toBe(true);
  });
});

describe("projectDelegatedChildRun", () => {
  it("keeps run/call/child identity and status", () => {
    expect(projectDelegatedChildRun({
      id: "run-123",
      call_name: "impl-from-design",
      args_json: JSON.stringify({ design_path: "spec/tasks/child.md" }),
      child_session_id: "lictor-child-123",
      status: "completed",
    })).toEqual({
      runId: "run-123",
      callName: "impl-from-design",
      taskLabel: "spec/tasks/child.md",
      childSessionId: "lictor-child-123",
      status: "completed",
    });
  });
});
