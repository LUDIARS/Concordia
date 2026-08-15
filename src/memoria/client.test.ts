import { describe, expect, it, vi } from "vitest";
import { MemoriaClient } from "./client.js";

function clientWith(response: Response): MemoriaClient {
  return new MemoriaClient({
    baseUrl: "http://memoria.test",
    fetchImpl: vi.fn(async () => response) as unknown as typeof fetch,
  });
}

describe("MemoriaClient task reads", () => {
  it("returns only validated open tasks", async () => {
    const client = clientWith(new Response(JSON.stringify({
      tasks: [
        { id: 1, title: "open", status: "open", details: null, category: "Cc" },
        { id: 2, title: "done", status: "done" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(client.listOpenTasks()).resolves.toEqual([
      { id: 1, title: "open", status: "open", details: null, category: "Cc", due_at: undefined },
    ]);
  });

  it("returns null for a missing task so spawn can reject the selected id", async () => {
    const client = clientWith(new Response("not found", { status: 404 }));
    await expect(client.getTask(42)).resolves.toBeNull();
  });

  it("rejects malformed task payloads at the HTTP boundary", async () => {
    const client = clientWith(new Response(JSON.stringify({
      tasks: [{ id: "1", title: "invalid", status: "open" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.listOpenTasks()).rejects.toThrow("invalid task");
  });
});

describe("MemoriaClient write errors", () => {
  it("does not copy response bodies into logged exceptions", async () => {
    const client = clientWith(new Response("private upstream diagnostic", { status: 500 }));
    await expect(client.completeTask(7)).rejects.toThrow("memoria PATCH /api/tasks/7 failed: 500");
    await expect(client.completeTask(7)).rejects.not.toThrow("private upstream diagnostic");
  });
});
