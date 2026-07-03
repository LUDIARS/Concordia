import { describe, it, expect } from "vitest";
import { claudeCodeProvider, encodeCwdForClaude } from "../src/providers/claude-code.js";
import { codexCliProvider } from "../src/providers/codex-cli.js";
import { codexSessionIdFromRecord } from "../src/providers/codex-session-id.js";

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

describe("codexCliProvider", () => {
  it("resolveSessionId picks env vars", () => {
    expect(codexCliProvider.resolveSessionId({ CODEX_SESSION_ID: "abc" })).toBe("abc");
    expect(codexCliProvider.resolveSessionId({ CONCORDIA_SESSION_ID: "xyz" })).toBe("xyz");
    expect(codexCliProvider.resolveSessionId({})).toBeNull();
  });

  it("parseTranscript extracts assistant text from Codex JSONL", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "s1", cwd: "E:\\Document\\Ars" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will inspect the repo." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: { command: "rg foo" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      }),
    ];

    const r = codexCliProvider.parseTranscript(lines.join("\n"));
    expect(r.jsonl_lines).toBe(4);
    expect(r.last_message_role).toBe("assistant");
    expect(r.last_text_summary).toBe("Done.");
    expect(r.last_tool_use?.tool).toBe("shell_command");
  });

  it("parseTranscript tolerates malformed lines", () => {
    const r = codexCliProvider.parseTranscript(
      ["{not json}", JSON.stringify({ payload: { role: "assistant", text: "ok" } })].join("\n"),
    );
    expect(r.last_text_summary).toBe("ok");
  });

  it("codexSessionIdFromRecord prefers payload.session_id over payload.id", () => {
    expect(codexSessionIdFromRecord({ type: "session_meta", payload: { session_id: "sid", id: "id" } })).toBe("sid");
    expect(codexSessionIdFromRecord({ type: "session_meta", payload: { id: "id-only" } })).toBe("id-only");
    expect(codexSessionIdFromRecord({ session_id: "top" })).toBe("top");
    expect(codexSessionIdFromRecord(null)).toBeNull();
  });
});
