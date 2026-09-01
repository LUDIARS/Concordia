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

  it("schedules the Quaestor invoice job on the last day of each month at 18:10 JST", () => {
    const job = CRON_JOBS.find(({ name }) => name === "quaestor-invoice-monthly");

    expect(job).toMatchObject({
      cron: "10 18 L * *",
      call_name: "quaestor-invoice-monthly",
    });
    // Quaestor 本体で実行するため cwd はテンプレートの default_cwd に委ねる。
    expect(job?.cwd).toBeUndefined();
    expect(job?.buildArgs()).toMatchObject({ month: expect.stringMatching(/^\d{6}$/) });
  });

  it("チーム定時 fanout ジョブを持たない (2026-09-01 neco 指示: チームは spawn + 散歩だけ)", () => {
    const fanned = CRON_JOBS.filter((job) => job.fanout).map((job) => job.name);
    expect(fanned).toEqual([]);

    const removed = [
      "team-standup-daily",
      "team-review-regular",
      "director-issue-scout-weekly",
      "director-task-organize-daily",
    ];
    for (const name of removed) {
      expect(CRON_JOBS.find((job) => job.name === name)).toBeUndefined();
    }
  });
});
