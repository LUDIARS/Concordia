import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import type { InstructionAgent } from "../agent-instructions/instruction-policy.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import type { DelegationService } from "../delegation/service.js";
import { createAgentDispatcher } from "./agent-dispatch.js";
import { createMailSweepExecution } from "./agent-job-sources/mail-sweep-execution.js";
import { createMailSweepStore } from "./agent-job-sources/mail-sweep-store.js";
import { createKaizenDailyJob } from "./agent-jobs/kaizen-daily.js";
import { createQuaestorMailSweepJob } from "./agent-jobs/quaestor-mail-sweep.js";
import type { MailSweepData } from "./agent-jobs/quaestor-mail-sweep-data.js";
import type { AgentJobRegistry } from "./agent-jobs/registry.js";
import type { AgentJobSpec } from "./agent-jobs/types.js";
import { startCronScheduler } from "./cron-scheduler.js";
import type { CronJobDefinition } from "./cron-jobs.js";

// spec/feature/parttimer-agent-dispatch.md CC-PT-AGENT-INV-01 / 02 / 03
const NEVER_FIRES = "0 0 1 1 *";
const FIRED_AT = new Date("2026-11-24T22:10:30Z"); // JST 2026-11-25 07:10

function spec(jobName: string, data: Record<string, unknown> = { items: ["a"] }): AgentJobSpec {
  return { jobName, body: "判断して返す", resultKind: "報告", buildData: vi.fn(async () => data) };
}

function setup(options: { agents?: Record<string, InstructionAgent>; specs?: AgentJobSpec[] } = {}) {
  const service = new InstructionService({ store: new SqliteAgentInstructionStore(makeTestDb()), now: () => FIRED_AT });
  const specs = new Map((options.specs ?? []).map((item) => [item.jobName, item]));
  const jobs: AgentJobRegistry = { get: (name) => specs.get(name) ?? null };
  const warn = vi.fn();
  const dispatch = createAgentDispatcher({
    resolveAgent: (name) => options.agents?.[name] ?? null,
    jobs,
    instructions: service,
    templateTitle: (callName) => (callName === "team-standup-daily" ? "チーム朝礼" : null),
    log: { warn },
  });
  const invoke = vi.fn(async (_input: unknown) => ({ ok: true, run: { id: "run-1" }, spawn_pid: 1 }));
  return { service, dispatch, invoke, warn, delegationService: { invoke } as unknown as DelegationService };
}

const job = (overrides: Partial<CronJobDefinition> = {}): CronJobDefinition => ({
  name: "deps-sweep-daily", cron: NEVER_FIRES, call_name: "deps-sweep-daily", buildArgs: () => ({ date: "2026-11-25" }), ...overrides,
});

describe("cron scheduler の外部エージェント分岐", () => {
  let handle: ReturnType<typeof startCronScheduler> | null = null;
  afterEach(() => { handle?.stop(); handle = null; });

  it("INV-01: 宛先未設定のジョブは従来どおり委託を invoke し、 指令を出さない", async () => {
    const ctx = setup({ specs: [spec("deps-sweep-daily")] });
    handle = startCronScheduler({ delegationService: ctx.delegationService, dispatchToAgent: ctx.dispatch, now: () => FIRED_AT }, [job()]);
    await handle.triggerNow();
    expect(ctx.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.service.history({ limit: 10 })).toEqual([]);
  });

  it("INV-02: 宛先 dots なら invoke せず run_task の指令を 1 件出す (params に job・dedupe_key・data)", async () => {
    const ctx = setup({ agents: { "deps-sweep-daily": "dots" }, specs: [spec("deps-sweep-daily")] });
    handle = startCronScheduler({ delegationService: ctx.delegationService, dispatchToAgent: ctx.dispatch, now: () => FIRED_AT }, [job()]);
    await handle.triggerNow();
    expect(ctx.invoke).not.toHaveBeenCalled();
    const rows = ctx.service.history({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "dots", type: "run_task", title: "deps-sweep-daily", body: "判断して返す" });
    expect(rows[0]!.params).toEqual({
      job: "deps-sweep-daily", fired_at: FIRED_AT.toISOString(), dedupe_key: "cron:deps-sweep-daily:-:2026-11-25T07:10",
      call_name: "deps-sweep-daily", args: { date: "2026-11-25" }, data: { items: ["a"] },
    });
  });

  it("INV-02: fanout は対象ごとに 1 件、 題にチーム名を付け、 同じ発火の再実行は登録しない (dedupe)", async () => {
    const ctx = setup({ agents: { "team-standup": "dots" }, specs: [spec("team-standup")] });
    const fanoutJob = job({ name: "team-standup", call_name: "team-standup-daily", fanout: "teams" });
    handle = startCronScheduler({
      delegationService: ctx.delegationService, dispatchToAgent: ctx.dispatch, now: () => FIRED_AT,
      fanoutResolvers: { teams: () => [
        { key: "alpha", args: { team_id: "t1", team_name: "アルファ" }, options: { team: "t1" } },
        { key: "beta", args: { team_id: "t2", team_name: "ベータ" }, options: { team: "t2" } },
      ] },
    }, [fanoutJob]);
    await handle.triggerNow();
    await handle.triggerNow();
    const rows = ctx.service.history({ limit: 10 });
    expect(ctx.invoke).not.toHaveBeenCalled();
    expect(rows.map((row) => row.title).sort()).toEqual(["チーム朝礼 — アルファ", "チーム朝礼 — ベータ"]);
    expect(rows.map((row) => (row.params as { dedupe_key: string }).dedupe_key).sort()).toEqual([
      "cron:team-standup:alpha:2026-11-25T07:10", "cron:team-standup:beta:2026-11-25T07:10",
    ]);
    expect(rows.map((row) => (row.params as { options: unknown }).options)).toContainEqual({ team: "t1" });
  });

  it("data builder の無いジョブに宛先が入っていても委託へ回す (warn を残す)", async () => {
    const ctx = setup({ agents: { "deps-sweep-daily": "dots" } });
    handle = startCronScheduler({ delegationService: ctx.delegationService, dispatchToAgent: ctx.dispatch, now: () => FIRED_AT }, [job()]);
    await handle.triggerNow();
    expect(ctx.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.warn).toHaveBeenCalled();
  });

  it("data builder が失敗したら委託で作業を落とさない", async () => {
    const failing = spec("deps-sweep-daily");
    failing.buildData = async () => { throw new Error("source down"); };
    const ctx = setup({ agents: { "deps-sweep-daily": "dots" }, specs: [failing] });
    handle = startCronScheduler({ delegationService: ctx.delegationService, dispatchToAgent: ctx.dispatch, now: () => FIRED_AT }, [job()]);
    await handle.triggerNow();
    expect(ctx.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.service.history({ limit: 10 })).toEqual([]);
  });

  it("INV-03: params は 8000 バイトに収め、 落とした件数を data.truncated に、 メール・トークンは伏せる", async () => {
    const many = Array.from({ length: 400 }, (_, index) => `item-${index}-${"x".repeat(30)}`);
    // トークン形の偽値は実行時に組み立てる (ソースに置くと情報流出検査が本物と区別できない)。
    const fakeToken = ["ghp", "abcdefghijklmnop1234"].join("_");
    const ctx = setup({
      agents: { "deps-sweep-daily": "muse" },
      specs: [spec("deps-sweep-daily", { items: many, owner: "連絡先 someone@example.com", token: fakeToken })],
    });
    const outcome = await ctx.dispatch({ jobName: "deps-sweep-daily", targetKey: "", args: {}, callName: "deps-sweep-daily", firedAt: FIRED_AT });
    expect(outcome.kind).toBe("registered");
    const params = ctx.service.history({ limit: 1 })[0]!.params as { data: { items: string[]; truncated: number; owner: string; token: string } };
    expect(Buffer.byteLength(JSON.stringify(params), "utf8")).toBeLessThanOrEqual(8000);
    expect(params.data.truncated).toBe(400 - params.data.items.length);
    expect(params.data.items[0]).toBe(many[0]);
    expect(params.data.owner).not.toContain("someone@example.com");
    expect(params.data.token).toBe("[redacted]");
  });

  it.each<MailSweepData>([
    { sweep_status: "completed", disabled: false, needs_review_ids: [], fetched: 0,
      processed: { invoice: 0, cloud_notice: 0, ci_failure: 0, dependabot: 0, ignore: 0 },
      committed: 0, needs_review: 0, notified: 0, errors: [] },
    { sweep_status: "unknown", failure_kind: "timeout" },
  ])("dots 宛てで同じ発火を繰り返しても sweep と指令はそれぞれ 1 件 (%j)", async (result) => {
    const db = makeTestDb();
    try {
      const sweep = vi.fn(async () => result);
      const mail = createQuaestorMailSweepJob({ prepareMailSweep: createMailSweepExecution(createMailSweepStore(db), sweep) });
      const ctx = setup({ agents: { [mail.jobName]: "dots" }, specs: [mail] });
      handle = startCronScheduler({ delegationService: ctx.delegationService, dispatchToAgent: ctx.dispatch, now: () => FIRED_AT },
        [job({ name: mail.jobName, call_name: mail.jobName, buildArgs: () => ({ body: "private" }) })]);
      await Promise.all([handle.triggerNow(), handle.triggerNow()]);
      await handle.triggerNow();
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(ctx.invoke).not.toHaveBeenCalled();
      expect(ctx.service.history({ limit: 10 })).toEqual([expect.objectContaining({
        agent: "dots", type: "run_task", params: {
          job: mail.jobName, dedupe_key: `cron:${mail.jobName}:-:2026-11-25T07:10`, fired_at: FIRED_AT.toISOString(),
          data: { ...result, slot: expect.any(String), date: "2026-11-25" },
        },
      })]);
    } finally {
      db.close();
    }
  });

  it.each(["quaestor-mail-sweep", "kaizen-daily"])("%s の宛先が空なら従来の委託を起動する", async (name) => {
    const definition = spec(name);
    definition.prepare = vi.fn();
    const ctx = setup({ specs: [definition] });
    handle = startCronScheduler({ delegationService: ctx.delegationService, dispatchToAgent: ctx.dispatch, now: () => FIRED_AT },
      [job({ name, call_name: name })]);
    await handle.triggerNow();
    expect(ctx.invoke).toHaveBeenCalledWith(expect.objectContaining({ call_name: name }));
    expect(definition.prepare).not.toHaveBeenCalled();
    expect(definition.buildData).not.toHaveBeenCalled();
    expect(ctx.service.history({ limit: 10 })).toEqual([]);
  });

  it("カイゼンの params は 8000 バイトに収め、省いた集計の件数を付ける", async () => {
    const facts = createKaizenDailyJob({
      kaizenFacts: () => ({
        failed_runs: Array.from({ length: 500 }, (_, index) => ({ call_name: `job-${index}`, reason: "timeout", count: 1 })),
        failed_cron_jobs: [], hook_denials: [], human_waiting: 3, instruction_requeues: null,
      }),
    });
    const ctx = setup({ agents: { [facts.jobName]: "dots" }, specs: [facts] });
    await ctx.dispatch({ jobName: facts.jobName, targetKey: "", args: {}, callName: facts.jobName, firedAt: FIRED_AT });
    const params = ctx.service.history({ limit: 1 })[0]?.params as {
      data: { date: string; failed_runs: unknown[]; truncated: number; human_waiting: number };
    };
    expect(Buffer.byteLength(JSON.stringify(params), "utf8")).toBeLessThanOrEqual(8000);
    expect(params.data).toMatchObject({ date: "2026-11-24", human_waiting: 3 });
    expect(params.data.truncated).toBe(500 - params.data.failed_runs.length);
  });
});
