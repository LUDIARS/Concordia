import { describe, expect, it, vi } from "vitest";
import { completeLinkedMemoriaTask } from "./end-session-flow.js";

function session(metadata: string | null) {
  return { id: "s1", metadata } as { id: string; metadata: string | null };
}

describe("completeLinkedMemoriaTask", () => {
  it("completes the task recorded at spawn time", async () => {
    const completeTask = vi.fn().mockResolvedValue(undefined);
    const done = await completeLinkedMemoriaTask(
      { memoria: { completeTask } },
      session(JSON.stringify({ memoria_task_id: 42 })),
    );
    expect(completeTask).toHaveBeenCalledWith(42);
    expect(done).toBe(42);
  });

  it("does nothing when the session carries no linked task", async () => {
    const completeTask = vi.fn();
    expect(await completeLinkedMemoriaTask({ memoria: { completeTask } }, session(null))).toBeNull();
    expect(await completeLinkedMemoriaTask({ memoria: { completeTask } }, session("{}"))).toBeNull();
    expect(completeTask).not.toHaveBeenCalled();
  });

  it("ignores unparsable metadata and non-positive ids instead of throwing", async () => {
    const completeTask = vi.fn();
    expect(await completeLinkedMemoriaTask({ memoria: { completeTask } }, session("not json"))).toBeNull();
    expect(await completeLinkedMemoriaTask(
      { memoria: { completeTask } },
      session(JSON.stringify({ memoria_task_id: 0 })),
    )).toBeNull();
    expect(await completeLinkedMemoriaTask(
      { memoria: { completeTask } },
      session(JSON.stringify({ memoria_task_id: "42" })),
    )).toBeNull();
    expect(completeTask).not.toHaveBeenCalled();
  });

  it("never fails session end when Memoria rejects", async () => {
    const completeTask = vi.fn().mockRejectedValue(new Error("memoria down"));
    await expect(completeLinkedMemoriaTask(
      { memoria: { completeTask } },
      session(JSON.stringify({ memoria_task_id: 7 })),
    )).resolves.toBeNull();
  });

  it("is a no-op when no Memoria port is wired", async () => {
    expect(await completeLinkedMemoriaTask({}, session(JSON.stringify({ memoria_task_id: 7 })))).toBeNull();
  });
});
