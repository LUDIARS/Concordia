import { describe, expect, it } from "vitest";
import { CRON_JOBS } from "./cron-jobs.js";

describe("CRON_JOBS", () => {
  it("schedules the LUDIARS dashboard report at 3:00 JST using the template cwd", () => {
    const job = CRON_JOBS.find(({ name }) => name === "ludiars-status-daily");

    expect(job).toMatchObject({
      cron: "0 3 * * *",
      call_name: "ludiars-status-daily",
    });
    expect(job?.cwd).toBeUndefined();
    expect(job?.buildArgs()).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it("schedules Steam persona collection at 7:40 JST using the template cwd", () => {
    const job = CRON_JOBS.find(({ name }) => name === "steam-persona-daily");

    expect(job).toMatchObject({
      cron: "40 7 * * *",
      call_name: "steam-persona-daily",
    });
    expect(job?.cwd).toBeUndefined();
    expect(job?.buildArgs()).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it("schedules the Vultus catalog refresh at 8:20 JST using the template cwd", () => {
    const job = CRON_JOBS.find(({ name }) => name === "vultus-catalog-refresh-daily");

    expect(job).toMatchObject({
      cron: "20 8 * * *",
      call_name: "vultus-catalog-refresh-daily",
    });
    expect(job?.cwd).toBeUndefined();
    expect(job?.buildArgs()).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it("朝礼を毎朝 9:30 JST にチームごとへ fanout する", () => {
    const job = CRON_JOBS.find(({ name }) => name === "team-standup-daily");

    expect(job).toMatchObject({
      cron: "30 9 * * *",
      call_name: "team-standup-daily",
      fanout: "teams",
    });
    // 先行する日次ジョブ (カイゼン 9:00) の結果を引用できるよう後ろに置く。
    expect(job?.cwd).toBe("E:\\Document\\Ars");
  });

  it("定例を火・金 13:00 JST にチームごとへ fanout する", () => {
    const job = CRON_JOBS.find(({ name }) => name === "team-review-regular");

    expect(job).toMatchObject({
      cron: "0 13 * * 2,5",
      call_name: "team-review-regular",
      fanout: "teams",
    });
  });

  it("fanout を使うのは朝礼・定例・課題スカウト・タスク整理だけ (既存の日次ジョブは 1 本のまま)", () => {
    const fanned = CRON_JOBS.filter((job) => job.fanout).map((job) => job.name);

    expect(fanned).toEqual([
      "team-standup-daily",
      "team-review-regular",
      "director-issue-scout-weekly",
      "director-task-organize-daily",
    ]);
  });
});
