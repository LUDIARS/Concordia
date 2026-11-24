import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { createOriginalInvoker, runAgentFallback } from "./agent-fallback.js";
import { createAgentResultIntake } from "./agent-result-intake.js";
import type { CronJobDefinition } from "./cron-jobs.js";

// spec/feature/parttimer-agent-dispatch.md CC-PT-AGENT-INV-05
function setup() {
  const clock = { now: new Date("2026-11-24T00:00:00Z") };
  let seq = 0;
  const service = new InstructionService({
    store: new SqliteAgentInstructionStore(makeTestDb()),
    now: () => clock.now,
    randomSuffix: () => (seq++).toString(16).padStart(6, "0"),
  });
  const register = (job: string, target = "") => service.registerOnce({
    agent: "dots", type: "run_task", title: job, body: "b", dedupeKey: `cron:${job}:${target || "-"}:2026-11-24T09:00`,
    params: { job, ...(target ? { target } : {}), dedupe_key: `cron:${job}:${target || "-"}:2026-11-24T09:00`, call_name: job, args: { date: "2026-11-24" }, ...(target ? { options: { team: target } } : {}) },
  }).id;
  const invokeOriginal = vi.fn(async () => ({ ok: true as const, runId: "run-1" }));
  const post = vi.fn(async (_text: string) => true);
  const log = { info: vi.fn(), warn: vi.fn() };
  const run = () => runAgentFallback({ instructions: service, fallbackMinutes: () => 180, invokeOriginal, post, now: () => clock.now, log });
  const advanceMinutes = (minutes: number) => { clock.now = new Date(clock.now.getTime() + minutes * 60_000); };
  return { service, register, invokeOriginal, post, run, advanceMinutes };
}

describe("受け取られない指令の戻し (agent-fallback)", () => {
  it("期限前は何もしない。 期限を過ぎた pending を failed で閉じ、 元の委託を 1 回だけ起動する", async () => {
    const ctx = setup();
    const id = ctx.register("deps-sweep-daily");
    ctx.advanceMinutes(179);
    expect(await ctx.run()).toEqual({ closed: 0, invoked: 0 });
    ctx.advanceMinutes(2);
    expect(await ctx.run()).toEqual({ closed: 1, invoked: 1 });
    expect(await ctx.run()).toEqual({ closed: 0, invoked: 0 });
    expect(ctx.invokeOriginal).toHaveBeenCalledTimes(1);
    expect(ctx.invokeOriginal.mock.calls[0]).toEqual([expect.objectContaining({ job: "deps-sweep-daily", args: { date: "2026-11-24" } })]);
    expect(ctx.service.get(id)).toMatchObject({ status: "failed", resultSummary: "期限内に受け取られなかったため Cc の委託へ戻した", ackedAt: null });
    expect(ctx.post.mock.calls[0]![0]).toContain("元の委託を起動しました");
  });

  it("受け取り済み (acked) の指令は閉じない", async () => {
    const ctx = setup();
    const id = ctx.register("deps-sweep-daily");
    ctx.service.ack(id, "dots");
    ctx.advanceMinutes(200);
    expect(await ctx.run()).toEqual({ closed: 0, invoked: 0 });
    expect(ctx.invokeOriginal).not.toHaveBeenCalled();
  });

  it("閉じた後の ack / result は 409 (conflict) で、 結果の投稿もしない", async () => {
    const ctx = setup();
    const id = ctx.register("deps-sweep-daily");
    const intakePost = vi.fn(async (_text: string) => true);
    const intake = createAgentResultIntake({
      paramsOf: (instructionId) => ctx.service.record(instructionId)?.params ?? null,
      jobs: { get: () => null },
      post: intakePost,
    });
    ctx.advanceMinutes(181);
    await ctx.run();
    expect(ctx.service.ack(id, "dots")).toEqual({ kind: "conflict", status: "failed" });
    expect(ctx.service.recordResult(id, { agent: "dots", status: "done", summary: "遅れて完了" })).toEqual({ kind: "conflict", status: "failed" });
    // Cc 自身が閉じた finished を受けても反映しない。
    await intake({ kind: "finished", id, agent: "dots", title: "t", status: "failed", summary: "x", detail: JSON.stringify({ closed_by: "concordia", fallback: "delegation" }), finishedAt: "z" });
    expect(intakePost).not.toHaveBeenCalled();
  });

  it("起動に失敗しても閉じたまま (二重起動しない) で、 失敗を投稿する", async () => {
    const ctx = setup();
    ctx.register("deps-sweep-daily");
    ctx.invokeOriginal.mockResolvedValueOnce({ ok: false, error: "quota" } as never);
    ctx.advanceMinutes(181);
    expect(await ctx.run()).toEqual({ closed: 1, invoked: 0 });
    expect(await ctx.run()).toEqual({ closed: 0, invoked: 0 });
    expect(ctx.post.mock.calls[0]![0]).toContain("起動に失敗しました");
  });

  it("元の委託は発火時の call_name・args・options・ジョブの cwd で起動する", async () => {
    const invoke = vi.fn(async (_input: unknown) => ({ ok: true as const, run: { id: "run-9" } }));
    const jobs: CronJobDefinition[] = [{ name: "standup", cron: "0 0 1 1 *", call_name: "team-standup-daily", buildArgs: () => ({}), cwd: "C:/work" }];
    const invokeOriginal = createOriginalInvoker({ jobs, delegation: { invoke } });
    expect(await invokeOriginal({ job: "standup", target: "alpha", callName: "override-tpl", args: { team_id: "t1" }, options: { team: "t1" }, dedupeKey: "cron:x" }))
      .toEqual({ ok: true, runId: "run-9" });
    expect(invoke).toHaveBeenCalledWith({
      call_name: "override-tpl", args: { team_id: "t1" }, cwd: "C:/work", triggered_by: "cron:standup:alpha:agent-fallback", options: { team: "t1" },
    });
    expect(await invokeOriginal({ job: "missing", target: "", callName: null, args: {}, options: null, dedupeKey: "cron:y" }))
      .toEqual({ ok: false, error: "unknown cron job: missing" });
  });
});
