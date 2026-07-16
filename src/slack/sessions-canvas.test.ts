import { describe, expect, it, vi } from "vitest";
import { SessionsCanvasController, renderSessionsCanvas } from "./sessions-canvas.js";
import type { SlackSessionIndexEntry } from "../platform/chat-read-model.js";

const rows: SlackSessionIndexEntry[] = [
  { sessionId: "active123", provider: "codex", status: "active", currentTask: "build", persona: "雑用係", updatedAt: 4, waiting: false },
  { sessionId: "waiting1", provider: "claude", status: "active", currentTask: "answer", persona: "相談役", updatedAt: 3, waiting: true },
  { sessionId: "ended12", provider: "codex", status: "ended", currentTask: "done", persona: "実装", updatedAt: 2, waiting: false },
  { sessionId: "lost1234", provider: "gemini", status: "lost", currentTask: null, persona: null, updatedAt: 1, waiting: false },
];

describe("Sessions Canvas", () => {
  it("classifies authoritative session states and renders channel links", () => {
    const markdown = renderSessionsCanvas(rows, (id) => `C-${id}`);
    expect(markdown).toContain("## Active\n- <#C-active123>");
    expect(markdown).toContain("## Waiting\n- <#C-waiting1>");
    expect(markdown).toContain("## Recently completed\n- <#C-ended12>");
    expect(markdown).toContain("## Failed / abandoned\n- <#C-lost1234>");
  });

  it("debounces updates, serializes edits, and recreates a deleted Canvas", async () => {
    vi.useFakeTimers();
    let stored: string | null = "old";
    const edit = vi.fn()
      .mockRejectedValueOnce(new Error("invalid_canvas"))
      .mockResolvedValue({ ok: true });
    const create = vi.fn(async () => ({ canvas_id: "new" }));
    const controller = new SessionsCanvasController({
      client: { canvases: { edit }, conversations: { canvases: { create } } },
      hubChannelId: "HUB",
      getSessions: () => rows,
      channelForSession: (id) => `C-${id}`,
      configGet: () => stored,
      configSet: (_key, value) => { stored = value; },
      configDelete: () => { stored = null; },
      debounceMs: 10,
    });

    controller.schedule();
    controller.schedule();
    await vi.advanceTimersByTimeAsync(10);
    await controller.refreshNow();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(stored).toBe("new");
    await controller.stop();
    vi.useRealTimers();
  });
});
