import { describe, expect, it, vi } from "vitest";
import { observeCodexCloudTasks } from "./codex-observer.js";

const page = (tasks: Array<{ id: string; status: string }>, cursor: string | null) =>
  JSON.stringify({ tasks: tasks.map(t => ({ ...t, url: "https://chatgpt.com/codex/tasks/" + t.id, title: "secret-ish title" })), cursor });
const input = { executable: "codex.exe", cwd: "repo", environmentId: "env_1" };

describe("Codex Cloud read-only observer", () => {
  it("uses the official list command and keeps only wanted ids with known statuses", async () => {
    const run = vi.fn(async () => page([{ id: "task_a", status: "pending" }, { id: "task_b", status: "ready" }, { id: "task_x", status: "error" }], null));
    const observed = await observeCodexCloudTasks({ ...input, wanted: new Set(["task_a", "task_b"]) }, run);
    expect([...observed]).toEqual([["task_a", "pending"], ["task_b", "ready"]]);
    expect(run).toHaveBeenCalledWith("codex.exe", ["cloud", "list", "--env", "env_1", "--json", "--limit", "20"], "repo");
  });
  it("follows cursors up to a bound and leaves unseen tasks absent", async () => {
    const run = vi.fn(async () => page([{ id: "task_other", status: "ready" }], "next"));
    const observed = await observeCodexCloudTasks({ ...input, wanted: new Set(["task_a"]) }, run);
    expect(observed.size).toBe(0);
    expect(run).toHaveBeenCalledTimes(5);
    expect((run.mock.calls[1] as unknown[])[1]).toContain("--cursor");
  });
  it("ignores unrecognised statuses and reports malformed output as a closed error", async () => {
    expect((await observeCodexCloudTasks({ ...input, wanted: new Set(["task_a"]) }, async () => page([{ id: "task_a", status: "mystery" }], null))).size).toBe(0);
    await expect(observeCodexCloudTasks({ ...input, wanted: new Set(["task_a"]) }, async () => "Not signed in")).rejects.toThrow("codex_cloud_observation_failed");
    await expect(observeCodexCloudTasks({ ...input, wanted: new Set(["task_a"]) }, async () => { throw new Error("token=abc"); })).rejects.toThrow("codex_cloud_observation_failed");
  });
  it("does not call the provider when nothing is wanted", async () => {
    const run = vi.fn(async () => "");
    expect((await observeCodexCloudTasks({ ...input, wanted: new Set() }, run)).size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
