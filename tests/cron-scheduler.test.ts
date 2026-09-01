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
      [{ name: "job-a", cron: NEVER_FIRES, call_name: "ludiars-review-daily", buildArgs: () => ({ date: "2026-07-09" }), cwd: "E:\\Document\\Ars" }],
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

  it("runs the active review, maintenance, catalog, and kaizen jobs by default", () => {
    expect(CRON_JOBS.map((j) => ({ name: j.name, cron: j.cron, call_name: j.call_name }))).toEqual([
      { name: "ludiars-status-daily", cron: "0 3 * * *", call_name: "ludiars-status-daily" },
      { name: "ludiars-review-weekly", cron: "40 4 * * 1", call_name: "ludiars-review-weekly" },
      { name: "vulnerability-response-daily", cron: "10 5 * * *", call_name: "vulnerability-response-daily" },
      { name: "ai-note-biweekly-review", cron: "10 6 1,15 * *", call_name: "ai-note-biweekly-review" },
      { name: "genius-ingest-daily", cron: "10 4 * * *", call_name: "genius-ingest-daily" },
      { name: "deps-sweep-daily", cron: "10 7 * * *", call_name: "deps-sweep-daily" },
      { name: "steam-persona-daily", cron: "40 7 * * *", call_name: "steam-persona-daily" },
      { name: "vultus-catalog-refresh-daily", cron: "20 8 * * *", call_name: "vultus-catalog-refresh-daily" },
      { name: "quaestor-invoice-monthly", cron: "10 18 L * *", call_name: "quaestor-invoice-monthly" },
      { name: "kaizen-daily", cron: "0 9 * * *", call_name: "kaizen-daily" },
    ]);
    // 横断レビュー系は Ars root 固定。 cwd はもと scheduler のハードコードだったので、
    // ジョブ定義側へ移したあとも消えていないことを回帰で押さえる。
    expect(CRON_JOBS.filter((j) => j.cwd === "E:\\Document\\Ars").map((j) => j.name)).toEqual([
      "ludiars-review-weekly",
      "vulnerability-response-daily",
      "ai-note-biweekly-review",
      "deps-sweep-daily",
      "kaizen-daily",
    ]);
    expect(CRON_JOBS.some((j) => j.name === "genius-ingest-tier2-nightly")).toBe(false);
  });

  it("gives every job a distinct name, call_name, and firing time", () => {
    // 同時刻に複数ジョブを置くと spawn が重なるため、時刻の衝突を回帰で防ぐ。
    const names = CRON_JOBS.map((j) => j.name);
    const callNames = CRON_JOBS.map((j) => j.call_name);
    const crons = CRON_JOBS.map((j) => j.cron);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(callNames).size).toBe(callNames.length);
    expect(new Set(crons).size).toBe(crons.length);
    // 分・時が一致するジョブは日付条件が違っても同日に重なりうるので、そこも重複させない。
    const minuteHour = crons.map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(new Set(minuteHour).size).toBe(minuteHour.length);
  });

  it("passes the run date to every scheduled job that requires it", () => {
    for (const name of [
      "ludiars-status-daily",
      "ludiars-review-weekly",
      "vulnerability-response-daily",
      "ai-note-biweekly-review",
      "genius-ingest-daily",
      "steam-persona-daily",
      "vultus-catalog-refresh-daily",
      "kaizen-daily",
    ]) {
      const job = CRON_JOBS.find((j) => j.name === name);
      expect(job, `${name} must be registered`).toBeDefined();
      expect(job?.buildArgs()).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    }
    expect(CRON_JOBS.find((j) => j.name === "deps-sweep-daily")?.buildArgs()).toEqual({});
  });

  it("invokes the Genius daily ingest delegation when its job fires", async () => {
    const invoke = vi.fn(async () => okResult());
    const job = CRON_JOBS.find((j) => j.name === "genius-ingest-daily");
    handle = startCronScheduler(
      { delegationService: fakeDelegationService(invoke) },
      [{ ...job!, cron: NEVER_FIRES }],
    );

    await handle.triggerNow("genius-ingest-daily");

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        call_name: "genius-ingest-daily",
        triggered_by: "cron:genius-ingest-daily",
      }),
    );
  });

  it("leaves the active Genius ingest cwd to the template's default_cwd (Genius repository)", async () => {
    // caller 指定の cwd は template.default_cwd より優先されるため、Ars root を渡すと
    // ingest が Genius repository の外で走ってしまう。cron 側は cwd を渡さないこと。
    const seenCwds: Array<string | undefined> = [];
    const invoke = vi.fn(async (input: { cwd?: string }) => {
      seenCwds.push(input.cwd);
      return okResult();
    });
    const jobs = CRON_JOBS.filter((j) => j.name.startsWith("genius-ingest-"));
    expect(jobs.map((j) => j.name)).toEqual(["genius-ingest-daily"]);
    handle = startCronScheduler(
      { delegationService: fakeDelegationService(invoke) },
      jobs.map((j) => ({ ...j, cron: NEVER_FIRES })),
    );

    await handle.triggerNow();

    expect(seenCwds).toEqual([undefined]);
  });
});
