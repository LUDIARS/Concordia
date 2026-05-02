import { describe, it, expect } from "vitest";
import { claudeCodeProvider, encodeCwdForClaude } from "../src/providers/claude-code.js";

describe("claudeCodeProvider", () => {
  it("encodes cwd to projects directory name", () => {
    expect(encodeCwdForClaude("E:\\Document\\Ars\\Foo")).toBe("E-Document-Ars-Foo");
    expect(encodeCwdForClaude("/home/u/proj")).toBe("home-u-proj");
  });

  it("resolveSessionId picks env vars", () => {
    expect(claudeCodeProvider.resolveSessionId({ CLAUDE_SESSION_ID: "abc" })).toBe("abc");
    expect(claudeCodeProvider.resolveSessionId({ CONCORDIA_SESSION_ID: "xyz" })).toBe("xyz");
    expect(claudeCodeProvider.resolveSessionId({})).toBeNull();
  });

  it("transcriptPath returns null for empty input", () => {
    expect(claudeCodeProvider.transcriptPath("", "")).toBeNull();
  });

  it("parseTranscript extracts last assistant text and TodoWrite", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "do x" }),
      JSON.stringify({
        role: "assistant",
        content: "I'll start with planning the approach.",
      }),
      JSON.stringify({
        type: "tool_use",
        name: "TodoWrite",
        input: {
          todos: [
            { subject: "plan", status: "completed" },
            { subject: "implement", status: "in_progress" },
          ],
        },
      }),
      JSON.stringify({
        type: "tool_use",
        name: "Edit",
        input: { file_path: "src/foo.ts" },
      }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Done editing." }],
      }),
    ];
    const r = claudeCodeProvider.parseTranscript(lines.join("\n"));
    expect(r.jsonl_lines).toBe(5);
    expect(r.last_message_role).toBe("assistant");
    expect(r.last_text_summary).toContain("Done editing");
    expect(r.last_tool_use?.tool).toBe("Edit");
    expect(r.todos).toEqual([
      { subject: "plan", status: "completed" },
      { subject: "implement", status: "in_progress" },
    ]);
  });

  it("parseTranscript tolerates malformed lines", () => {
    const lines = ["{not json}", JSON.stringify({ role: "assistant", content: "ok" })];
    const r = claudeCodeProvider.parseTranscript(lines.join("\n"));
    expect(r.last_text_summary).toBe("ok");
  });
});
