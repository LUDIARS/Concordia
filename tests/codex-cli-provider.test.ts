import { describe, it, expect } from "vitest";
import { codexCliProvider } from "../src/providers/codex-cli.js";

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
});
