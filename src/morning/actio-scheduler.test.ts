/** @implements spec/feature/task-workflow-v3.md — morning intake groups references by project/organization */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationService } from "../delegation/service.js";
import type { TaskStore } from "../taskflow/store.js";
import type { TaskDocument, TaskStatus } from "../taskflow/types.js";
import { startActioMorningScheduler } from "./actio-scheduler.js";

const stops: Array<{ stop(): void }> = [];
afterEach(() => { for (const scheduler of stops.splice(0)) scheduler.stop(); });

function task(input: {
  id: string; repoPath?: string; dueAt?: string | null; status?: TaskStatus; subsidiaryId?: string | null;
}): TaskDocument {
  return {
    path: `actio:${input.id}`, repoPath: input.repoPath ?? "E:/Document/Ars/Concordia",
    title: input.id, body: "",
    frontmatter: { task: input.id, project: "Concordia", kind: "実装", created: "2026-09-21", due_at: input.dueAt ?? null },
    runtime: {
      status: input.status ?? "pending", subsidiary_id: input.subsidiaryId ?? null, source_session: null,
      assignee: null, owner: null, delegation_run_id: null, pr_number: null, memoria_task_id: null,
      actio_task_id: input.id, memoria_registration_state: "idle",
    },
  };
}

type MorningInvocation = {
  call_name: string; cwd: string; subsidiary_id: string | null;
  args: Record<string, string>; triggered_by: string;
};

const invoker = () => vi.fn(async (_input: MorningInvocation) => ({ ok: true }));

function fixture(tasks: TaskDocument[], invoke = invoker()) {
  const scheduler = startActioMorningScheduler({
    delegationService: { invoke } as unknown as DelegationService,
    store: { scan: async () => tasks } as unknown as TaskStore,
    now: () => new Date("2026-09-21T08:00:00+09:00"),
  });
  stops.push(scheduler);
  return { scheduler, invoke };
}

describe("startActioMorningScheduler", () => {
  it("dispatches one delegation per project/organization with task references only", async () => {
    const { scheduler, invoke } = fixture([
      task({ id: "a", dueAt: "2026-09-21T10:00:00+09:00" }),
      task({ id: "b", dueAt: "2026-09-21T11:00:00+09:00" }),
      task({ id: "c", repoPath: "E:/Document/Ars/Ergo", dueAt: "2026-09-21T12:00:00+09:00" }),
    ]);

    await scheduler.runOnce();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![0]).toMatchObject({
      call_name: "morning-tasks", cwd: "E:/Document/Ars/Concordia", subsidiary_id: null,
      triggered_by: "morning-scheduler-actio",
      args: { task_list: "actio:a\nactio:b", date: "2026-09-21" },
    });
    expect(invoke.mock.calls[1]![0]).toMatchObject({ cwd: "E:/Document/Ars/Ergo" });
  });

  it("keeps a subsidiary's tasks in a separate dispatch from headquarters", async () => {
    const { scheduler, invoke } = fixture([
      task({ id: "a", dueAt: "2026-09-21T10:00:00+09:00" }),
      task({ id: "b", dueAt: "2026-09-21T10:00:00+09:00", subsidiaryId: "sub-1" }),
    ]);

    await scheduler.runOnce();

    expect(invoke.mock.calls.map((call) => call[0].subsidiary_id)).toEqual([null, "sub-1"]);
  });

  it("ignores tasks that are not pending or not due today", async () => {
    const { scheduler, invoke } = fixture([
      task({ id: "done", dueAt: "2026-09-21T10:00:00+09:00", status: "done" }),
      task({ id: "later", dueAt: "2026-09-22T10:00:00+09:00" }),
      task({ id: "none", dueAt: null }),
    ]);

    await scheduler.runOnce();

    expect(invoke).not.toHaveBeenCalled();
  });

  /** Claiming before dispatch keeps an unknown launch outcome from firing twice. */
  it("dispatches each group once per scheduler lifetime", async () => {
    const { scheduler, invoke } = fixture([task({ id: "a", dueAt: "2026-09-21T10:00:00+09:00" })]);

    await scheduler.runOnce();
    await scheduler.runOnce();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("continues with the other projects when one dispatch is rejected or throws", async () => {
    const invoke = invoker()
      .mockRejectedValueOnce(new Error("launch failed"))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const { scheduler } = fixture([
      task({ id: "a", repoPath: "E:/a", dueAt: "2026-09-21T10:00:00+09:00" }),
      task({ id: "b", repoPath: "E:/b", dueAt: "2026-09-21T10:00:00+09:00" }),
      task({ id: "c", repoPath: "E:/c", dueAt: "2026-09-21T10:00:00+09:00" }),
    ], invoke);

    await expect(scheduler.runOnce()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("stops dispatching once the scheduler is stopped", async () => {
    const { scheduler, invoke } = fixture([task({ id: "a", dueAt: "2026-09-21T10:00:00+09:00" })]);

    scheduler.stop();
    await scheduler.runOnce();

    expect(invoke).not.toHaveBeenCalled();
  });
});
