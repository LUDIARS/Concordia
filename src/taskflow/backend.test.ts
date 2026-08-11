/** @implements spec/feature/task-workflow.md — 2.2 登録 (reconcile) */

import { describe, expect, it } from "vitest";
import type { MemoriaClient } from "../memoria/client.js";
import { MemoriaBackend } from "./backend.js";

describe("MemoriaBackend", () => {
  it("marks connection setup failure as definitely not created", async () => {
    const cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const backend = new MemoriaBackend(clientRejecting(new TypeError("fetch failed", { cause })));

    await expect(backend.createTask({ title: "Task" })).rejects.toMatchObject({
      name: "TaskCreationError",
      outcome: "not-created",
    });
  });

  it("keeps ambiguous failures in the unknown outcome", async () => {
    const backend = new MemoriaBackend(clientRejecting(new Error("connection reset")));

    await expect(backend.createTask({ title: "Task" })).rejects.toMatchObject({
      name: "TaskCreationError",
      outcome: "unknown",
    });
  });
});

function clientRejecting(error: Error): MemoriaClient {
  return {
    createTask: async () => { throw error; },
  } as unknown as MemoriaClient;
}
