import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createInstructionEventRelay } from "../agent-instructions/instruction-events.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { createAgentResultIntake } from "./agent-result-intake.js";
import type { AgentJobRegistry } from "./agent-jobs/registry.js";
import { createKaizenDailyJob } from "./agent-jobs/kaizen-daily.js";
import { createQuaestorMailSweepJob } from "./agent-jobs/quaestor-mail-sweep.js";

// spec/feature/parttimer-agent-dispatch.md CC-PT-AGENT-INV-04
function setup() {
  const relay = createInstructionEventRelay({ warn: vi.fn() });
  const service = new InstructionService({ store: new SqliteAgentInstructionStore(makeTestDb()), events: (event) => relay.emit(event) });
  const posts: string[] = [];
  const kaizen = createKaizenDailyJob({ kaizenFacts: () => { throw new Error("not used by result intake"); } });
  const mail = createQuaestorMailSweepJob({ prepareMailSweep: async () => { throw new Error("not used by result intake"); } });
  const jobs: AgentJobRegistry = { get: (name) => {
    if (name === kaizen.jobName) return kaizen;
    if (name === mail.jobName) return mail;
    return name === "ai-note-biweekly-review" ? { jobName: name, body: "", resultKind: "下書き", buildData: async () => ({}) } : null;
  } };
  const intake = createAgentResultIntake({
    paramsOf: (id) => service.record(id)?.params ?? null,
    jobs,
    post: async (text) => { posts.push(text); },
  });
  relay.subscribe(intake);
  const register = (params: Record<string, unknown>) => service.register({ agent: "dots", type: "run_task", title: "AIノート記事 隔週レビュー", body: "b", params }).id;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { service, posts, register, flush };
}

describe("結果の引き取り (agent-result-intake)", () => {
  it("done の結果をジョブの種別で投稿し、 mention とリンク展開を無効化する", async () => {
    const ctx = setup();
    const id = ctx.register({ job: "ai-note-biweekly-review", dedupe_key: "cron:ai-note-biweekly-review:-:2026-11-24T06:10" });
    ctx.service.ack(id, "dots");
    ctx.service.recordResult(id, {
      agent: "dots", status: "done", summary: "3 件に直し案 @everyone <@123>",
      detail: { items: ["記事 A: https://evil.example/x のポートが古い", "記事 B: 変更不要"] },
    });
    await ctx.flush();
    expect(ctx.posts).toHaveLength(1);
    const post = ctx.posts[0]!;
    expect(post).toContain("dots の下書き");
    expect(post).toContain("記事 B: 変更不要");
    expect(post).not.toContain("@everyone");
    expect(post).not.toContain("<@123>");
    expect(post).not.toContain("https://evil.example");
    expect(post.length).toBeLessThanOrEqual(1900);
  });

  it("failed は「<エージェント> が失敗: 要約」と出す", async () => {
    const ctx = setup();
    const id = ctx.register({ job: "deps-sweep-daily", dedupe_key: "cron:deps-sweep-daily:-:x" });
    ctx.service.recordResult(id, { agent: "dots", status: "failed", summary: "マニフェストが読めない" });
    await ctx.flush();
    expect(ctx.posts).toEqual([expect.stringContaining("dots が失敗: マニフェストが読めない")]);
  });

  it.each([["quaestor-mail-sweep", "報告"], ["kaizen-daily", "提案"]])("%s の%sを通知先へ投稿する", async (job, kind) => {
    const ctx = setup();
    const id = ctx.register({ job, dedupe_key: `cron:${job}:-:2026-11-24T09:00` });
    ctx.service.recordResult(id, {
      agent: "dots", status: "done", summary: "概要 @everyone",
      detail: { items: ["確認事項 <@123> https://evil.example/x"] },
    });
    await ctx.flush();
    expect(ctx.posts).toHaveLength(1);
    expect(ctx.posts[0]).toContain(`dots の${kind}`);
    expect(ctx.posts[0]).toContain("確認事項");
    expect(ctx.posts[0]).not.toMatch(/@everyone|<@123>|https:\/\/evil\.example/);
  });

  it("cron 由来でない指令の結果は反映しない", async () => {
    const ctx = setup();
    const id = ctx.register({ note: "手動の指令" });
    ctx.service.recordResult(id, { agent: "dots", status: "done", summary: "ok" });
    await ctx.flush();
    expect(ctx.posts).toEqual([]);
  });
});
