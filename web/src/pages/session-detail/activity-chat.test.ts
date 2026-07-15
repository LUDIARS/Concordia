import { describe, expect, it } from "vitest";
import { toActivityMessage } from "./activity-chat.js";

describe("toActivityMessage", () => {
  it("keeps the complete assistant message without summary optimization or truncation", () => {
    const text = "x".repeat(5_000);
    const message = toActivityMessage({
      seq: 1,
      ts: 1,
      kind: "text",
      payload: { role: "assistant", phase: "commentary", text },
    });

    expect(message.author).toBe("Assistant");
    expect(message.detail).toBe("作業更新");
    expect(message.text).toBe(text);
    expect(message.text).toHaveLength(5_000);
  });

  it("renders detailed tool payloads instead of reducing them to a summary", () => {
    const message = toActivityMessage({
      seq: 2,
      ts: 2,
      kind: "tool",
      payload: { type: "command_execution", command: "npm test", status: "completed", exit_code: 0 },
    });

    expect(message.author).toBe("Tool");
    expect(message.detail).toBe("command_execution");
    expect(message.text).toContain('"command": "npm test"');
    expect(message.text).toContain('"exit_code": 0');
  });

  it("keeps summary frames alongside detailed activity", () => {
    const message = toActivityMessage({
      seq: 3,
      ts: 3,
      kind: "summary",
      payload: { summary: "conversation summary" },
    });

    expect(message.tone).toBe("summary");
    expect(message.detail).toBe("詳細ログと併記");
    expect(message.text).toBe("conversation summary");
  });
});
