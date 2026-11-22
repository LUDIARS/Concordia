import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "../taskflow/store.js";
import type { TaskDocument } from "../taskflow/types.js";
import { cloudTaskAuthorizer } from "./task-authorizer.js";

const scope = { repositoryKey: "ludiars/concordia", subsidiaryId: null };
const storeWith = (status?: string) => {
  const read = vi.fn(async () => ({ runtime: status ? { status } : undefined }) as unknown as TaskDocument);
  return { store: { read } as unknown as TaskStore, read };
};

describe("cloudTaskAuthorizer", () => {
  it("reads the task within the given repository and subsidiary scope", async () => {
    const { store, read } = storeWith("in_progress");
    await expect(cloudTaskAuthorizer(store)("task-1", { ...scope, subsidiaryId: "sub-a" }, true)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith("ludiars/concordia", "task-1", "sub-a");
  });

  it("fails closed when the task store cannot read tasks", async () => {
    await expect(cloudTaskAuthorizer({} as TaskStore)("task-1", scope)).rejects.toThrow("cloud_task_store_unavailable");
  });

  it.each(["done", "cancelled"])("rejects a %s task only when an active task is required", async status => {
    const { store } = storeWith(status);
    await expect(cloudTaskAuthorizer(store)("task-1", scope, true)).rejects.toThrow("cloud_task_not_active");
    await expect(cloudTaskAuthorizer(store)("task-1", scope)).resolves.toBeUndefined();
  });

  it("propagates a missing task from the store", async () => {
    const store = { read: vi.fn(async () => { throw new Error("task_not_found"); }) } as unknown as TaskStore;
    await expect(cloudTaskAuthorizer(store)("missing", scope, true)).rejects.toThrow("task_not_found");
  });
});
