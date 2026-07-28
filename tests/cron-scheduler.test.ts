import { describe, it, expect, vi, afterEach } from "vitest";
import { startCronScheduler } from "../src/scheduler/cron-scheduler.js";
import { CRON_JOBS } from "../src/scheduler/cron-jobs.js";
import type { DelegationService, InvokeResultOk } from "../src/delegation/service.js";

// 実際に発火させず (croner の時刻判定は上流ライブラリの責務)、triggerNow() 経由で
// 「正しい call_name / args で invoke されるか」だけを検証する。
// cron 式は年に一度しか一致しない過去日付にして、テスト中に本物の発火を起こさない。
const NEVER_FIRES = "0 0 1 1 *";

function fakeDelegationService(invoke: DelegationService["invoke"]): DelegationService {
  return { invoke } as unknown as DelegationService;
}

function okResult(): InvokeResultOk {
  return {
    ok: true,
    run: { id: "run-1" } as InvokeResultOk["run"],
    prompt_file_path: "/tmp/prompt.md",
    rendered_prompt: "",
    spawn_pid: 123,
    spawn_command: null,
    spawn_cwd: null,
    spawn_branch: null,
    spawn_worktree_path: null,
    spawn_worktree_created: false,
    queued: false,
    queue_position: null,
  };
}

describe("startCronScheduler", () => {
  let handle: ReturnType<typeof startCronScheduler> | null = null;

  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  it("triggerNow invokes the job's delegation with its built args", async () => {
    const invoke = vi.fn(async () => okResult());
    handle = startCronScheduler(
      { delegationService: fakeDelegationService(invoke) },
      [{ name: "job-a", cron: NEVER_FIRES, call_name: "ludiars-review-daily", buildArgs: () => ({ date: "2026-07-09" }) }],
    );

    await handle.triggerNow();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        call_name: "ludiars-review-daily",
        args: { date: "2026-07-09" },
        cwd: "E:\\Document\\Ars",
        triggered_by: "cron:job-a",
      }),
    );
  });

  it("triggerNow(jobName) only fires the matching job", async () => {
    const invoke = vi.fn(async () => okResult());
    handle = startCronScheduler(
      { delegationService: fakeDelegationService(invoke) },
      [
        { name: "job-a", cron: NEVER_FIRES, call_name: "call-a", buildArgs: () => ({}) },
        { name: "job-b", cron: NEVER_FIRES, call_name: "call-b", buildArgs: () => ({}) },
      ],
    );

    await handle.triggerNow("job-b");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ call_name: "call-b" }));
  });

  it("does not throw when invoke fails", async () => {
    const invoke = vi.fn(async () => ({ ok: false as const, error: "boom" }));
    handle = startCronScheduler(
      { delegationService: fakeDelegationService(invoke) },
      [{ name: "job-a", cron: NEVER_FIRES, call_name: "ludiars-review-daily", buildArgs: () => ({}) }],
    );

    await expect(handle.triggerNow()).resolves.toBeUndefined();
  });

  it("resolveCallNameOverride takes precedence over the job's default call_name", async () => {
    const invoke = vi.fn(async () => okResult());
    const resolveCallNameOverride = vi.fn((jobName: string) =>
      jobName === "job-a" ? "ludiars-review-daily" : null);
    handle = startCronScheduler(
      { delegationService: fakeDelegationService(invoke), resolveCallNameOverride },
      [{ name: "job-a", cron: NEVER_FIRES, call_name: "ludiars-review-daily-dual", buildArgs: () => ({ date: "2026-07-27" }) }],
    );

    await handle.triggerNow();

    expect(resolveCallNameOverride).toHaveBeenCalledWith("job-a");
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ call_name: "ludiars-review-daily" }),
    );
  });

  it("falls back to the job's default call_name when there is no override", async () => {
    const invoke = vi.fn(async () => okResult());
    handle = startCronScheduler(
      { delegationService: fakeDelegationService(invoke), resolveCallNameOverride: () => null },
      [{ name: "job-a", cron: NEVER_FIRES, call_name: "ludiars-review-daily-dual", buildArgs: () => ({}) }],
    );

    await handle.triggerNow();

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ call_name: "ludiars-review-daily-dual" }),
    );
  });

  it("runs the daily review and the biweekly AI note review by default", () => {
    expect(CRON_JOBS.map((j) => ({ name: j.name, cron: j.cron, call_name: j.call_name }))).toEqual([
      { name: "ludiars-review-daily", cron: "10 5 * * *", call_name: "ludiars-review-daily" },
      { name: "ai-note-biweekly-review", cron: "10 6 1,15 * *", call_name: "ai-note-biweekly-review" },
    ]);
  });
});
