import { describe, expect, it } from "vitest";
import { CRON_JOBS } from "./cron-jobs.js";

describe("CRON_JOBS", () => {
  it("schedules Steam persona collection at 7:40 JST using the template cwd", () => {
    const job = CRON_JOBS.find(({ name }) => name === "steam-persona-daily");

    expect(job).toMatchObject({
      cron: "40 7 * * *",
      call_name: "steam-persona-daily",
    });
    expect(job?.cwd).toBeUndefined();
    expect(job?.buildArgs()).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
});
