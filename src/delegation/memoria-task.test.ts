import { describe, expect, it, vi } from "vitest";
import { createDelegationMemoriaTask } from "./memoria-task.js";

const DRAFT = { title: "[impl] タスク", details: "why: ...\n\ntask:\n本文" };

describe("createDelegationMemoriaTask", () => {
  it("起票できたら id と link を返す", async () => {
    const port = {
      createTask: vi.fn().mockResolvedValue({ id: 42 }),
      taskApiUrl: (id: string | number) => `http://127.0.0.1:7777/api/tasks/${id}`,
    };
    const result = await createDelegationMemoriaTask(port, DRAFT, "run-1");
    expect(port.createTask).toHaveBeenCalledWith({ title: DRAFT.title, details: DRAFT.details });
    expect(result.link).toEqual({ id: "42", url: "http://127.0.0.1:7777/api/tasks/42" });
    expect(result.error).toBeNull();
  });

  it("Memoria が落ちていても委託は止めない (理由を返す)", async () => {
    const port = {
      createTask: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      taskApiUrl: (id: string | number) => `http://127.0.0.1:7777/api/tasks/${id}`,
    };
    const result = await createDelegationMemoriaTask(port, DRAFT, "run-1");
    expect(result.link).toBeNull();
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("port 未注入は理由つきで未起票にする (例外にしない)", async () => {
    const result = await createDelegationMemoriaTask(null, DRAFT, "run-1");
    expect(result.link).toBeNull();
    expect(result.error).toBe("memoria port unavailable");
  });
});
