import { describe, expect, it, vi } from "vitest";
import type { CronJobDefinition } from "./cron-jobs.js";
import { startCronScheduler, type CronSchedulerDeps } from "./cron-scheduler.js";

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    name: "job",
    cron: "0 9 * * *",
    call_name: "job",
    buildArgs: () => ({ date: "2026-08-17" }),
    ...overrides,
  };
}

function makeDeps(invoke = vi.fn().mockResolvedValue({ ok: true, run: { id: "run_1" }, spawn_pid: 1 })) {
  return {
    invoke,
    deps: { delegationService: { invoke } } as unknown as CronSchedulerDeps,
  };
}

/** triggerNow で 1 回発火させてから停止する (テスト中に実 cron を残さない)。 */
async function fireOnce(deps: CronSchedulerDeps, jobs: CronJobDefinition[]): Promise<void> {
  const handle = startCronScheduler(deps, jobs);
  try {
    await handle.triggerNow();
  } finally {
    handle.stop();
  }
}

describe("startCronScheduler", () => {
  it("fanout が無いジョブは 1 回だけ invoke する", async () => {
    const { deps, invoke } = makeDeps();

    await fireOnce(deps, [makeJob()]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toMatchObject({
      call_name: "job",
      args: { date: "2026-08-17" },
      triggered_by: "cron:job",
    });
    expect(invoke.mock.calls[0][0].options).toBeUndefined();
  });

  it("fanout 対象ごとに invoke し、args と options を対象で上書きする", async () => {
    const { deps, invoke } = makeDeps();
    const scheduler = {
      ...deps,
      fanoutResolvers: {
        teams: () => [
          { key: "alpha", args: { team_id: "team_a" }, options: { team: "team_a" } },
          { key: "glab", args: { team_id: "team_g" }, options: { team: "team_g" } },
        ],
      },
    } as CronSchedulerDeps;

    await fireOnce(scheduler, [makeJob({ name: "standup", call_name: "standup", fanout: "teams" })]);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][0]).toMatchObject({
      args: { date: "2026-08-17", team_id: "team_a" },
      options: { team: "team_a" },
      triggered_by: "cron:standup:alpha",
    });
    expect(invoke.mock.calls[1][0]).toMatchObject({
      args: { date: "2026-08-17", team_id: "team_g" },
      triggered_by: "cron:standup:glab",
    });
  });

  it("fanout 対象が 0 件なら 1 度も invoke しない", async () => {
    const { deps, invoke } = makeDeps();
    const scheduler = { ...deps, fanoutResolvers: { teams: () => [] } } as CronSchedulerDeps;

    await fireOnce(scheduler, [makeJob({ fanout: "teams" })]);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("resolver 未登録の fanout ジョブは宛先不明なので起動しない", async () => {
    const { deps, invoke } = makeDeps();

    await fireOnce(deps, [makeJob({ fanout: "teams" })]);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("1 対象が失敗しても残りの対象は起動する", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "boom" })
      .mockResolvedValue({ ok: true, run: { id: "run_2" }, spawn_pid: 2 });
    const { deps } = makeDeps(invoke);
    const scheduler = {
      ...deps,
      fanoutResolvers: {
        teams: () => [
          { key: "alpha", args: {} },
          { key: "glab", args: {} },
        ],
      },
    } as CronSchedulerDeps;

    await fireOnce(scheduler, [makeJob({ fanout: "teams" })]);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("1 対象の invoke が reject しても残りの対象は起動する", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ok: true, run: { id: "run_2" }, spawn_pid: 2 });
    const { deps } = makeDeps(invoke);
    const scheduler = {
      ...deps,
      fanoutResolvers: {
        teams: () => [
          { key: "alpha", args: {} },
          { key: "glab", args: {} },
        ],
      },
    } as CronSchedulerDeps;

    await fireOnce(scheduler, [makeJob({ fanout: "teams" })]);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("call_name の override は fanout でも効く", async () => {
    const { deps, invoke } = makeDeps();
    const scheduler = {
      ...deps,
      resolveCallNameOverride: () => "other-template",
      fanoutResolvers: { teams: () => [{ key: "alpha", args: {} }] },
    } as CronSchedulerDeps;

    await fireOnce(scheduler, [makeJob({ fanout: "teams" })]);

    expect(invoke.mock.calls[0][0]).toMatchObject({ call_name: "other-template" });
  });
});
