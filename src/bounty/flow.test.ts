import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BountyReportersRepo } from "../db/bounty-reporters-repo.js";
import { BountyReportsRepo } from "../db/bounty-reports-repo.js";
import { createBountyFlow } from "./composition.js";
import type { BountyActioPort, BountyRunStatus } from "./ports.js";

const USER = "905235114026467350";

/** 実 DB の台帳と、外部 (委託・Actio・PR・通知・報奨) の fake で組み立てる。 */
function setup(options: { companyId?: string | null; revisorWorkflow?: string | null; hotfixLimit?: number } = {}) {
  const db = makeTestDb();
  const reports = new BountyReportsRepo(db);
  const reporters = new BountyReportersRepo(db);
  const companyId = options.companyId === undefined ? "sub_a" : options.companyId;
  const reporter = reporters.findOrCreate({ subsidiary_id: companyId, platform: "discord", platform_user_id: USER }, 1);
  reporters.setPublicName({ subsidiary_id: companyId, platform: "discord", platform_user_id: USER }, "neco", 1);
  const runs = new Map<string, { status: BountyRunStatus; childSessionId: string | null }>();
  const launches: Array<{ runId: string; callName: string; args: Record<string, unknown>; branch?: string; taskflowReference?: string }> = [];
  const delegation = {
    launch: vi.fn(async (input: { runId: string; callName: string; args: Record<string, unknown>; branch?: string; taskflowReference?: string }) => {
      launches.push(input);
      runs.set(input.runId, { status: "running", childSessionId: `child-${launches.length}` });
      return { ok: true as const };
    }),
    findRun: (runId: string) => runs.get(runId) ?? null,
  };
  const actioState = { result: { ok: true as const, taskRef: "actio:task-1" } as Awaited<ReturnType<BountyActioPort["createIssueTask"]>>, status: "open" };
  const actio: BountyActioPort = {
    createIssueTask: vi.fn(async () => actioState.result),
    taskStatus: vi.fn(async () => actioState.status),
  };
  const prBySession = new Map<string, string>();
  const replies: Array<{ id: string; message: string }> = [];
  const authority: string[] = [];
  const rewards = {
    requestReward: vi.fn(() => ({ status: "granted" as const, entry: { tokens: 1_000_000 } })),
    revokeReward: vi.fn(() => ({ status: "revoked" as const, entry: { tokens: 1_000_000 } })),
  };
  const flow = createBountyFlow({
    ledger: reports,
    reporters,
    projects: {
      registered: () => ["Cc", "At"],
      companyProjects: (id) => (id === null ? null : ["Cc"]),
      repoPath: (code) => (code === "Cc" ? "E:/Document/Ars/Concordia" : null),
      revisorWorkflow: () => (options.revisorWorkflow === undefined ? "revisor" : options.revisorWorkflow),
    },
    delegation,
    actio,
    prs: { prOfSession: (sessionId) => prBySession.get(sessionId) ?? null, sessionsOfTask: () => ["worker-1"] },
    notifier: {
      replyToReporter: async (report, message) => { replies.push({ id: report.id, message }); return true; },
      notifyAuthority: async (message) => { authority.push(message); return true; },
    },
    rewards,
    sessionActive: () => true,
    hotfixDailyLimit: () => options.hotfixLimit ?? 5,
  });
  const submit = (key: string, project: string | null = "Cc") => reports.create({
    subsidiary_id: companyId, project_code: project, reporter_kind: "person", reporter_id: reporter.id,
    reporter_session_id: null, recipient_reporter_id: reporter.id, what_happened: "スレッドが作られない",
    repro_steps: "/spawn", intake_platform: "discord", intake_key: `discord:${key}`,
    intake_ref_json: JSON.stringify({ channel_id: "55555" }), status: "received",
  }, { actor_kind: "human", actor_id: reporter.id }).row;
  return { db, reports, reporters, reporter, flow, runs, launches, delegation, actio, actioState, prBySession, replies, authority, rewards, submit };
}

const acceptedResult = {
  verdict: "accepted", severity: "s2", sensitive: false, self_inflicted: false, hotfix_eligible: true,
  public_title: "スレッドが作られない", public_summary: "spawn 後にスレッドが無い", reason: "再現した",
};

describe("bug-bounty flow: triage → Actio task → hotfix → PR → deploy → reward", () => {
  it("launches a read-only triage, accepts the result only from that run's session, and carries the report to deployment", async () => {
    const t = setup();
    const report = t.submit("1");
    await t.flow.tick();
    expect(t.launches[0]).toMatchObject({ callName: "bounty-triage-review" });
    expect(String(t.launches[0]!.args.task)).toContain("<<<BOUNTY-MATERIAL");
    const triageRun = t.reports.find(report.id)!.triage_run_id!;
    expect(triageRun).toBeTruthy();

    // 別のセッションからの結果は受けない (CC-BOUNTY-INV-01)。
    expect(await t.flow.triage.acceptResult({ sessionId: "intruder", reportId: report.id, raw: acceptedResult }))
      .toEqual({ ok: false, error: "not_triage_session" });

    expect(await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: acceptedResult }))
      .toEqual({ ok: true, status: "accepted" });
    // 採用 → Actio タスク作成で fix_pending → hotfix の条件を満たして fixing。
    const fixing = t.reports.find(report.id)!;
    expect(fixing).toMatchObject({ status: "fixing", actio_task_ref: "actio:task-1", triage_run_id: null, verdict: "accepted" });
    expect(t.launches[1]).toMatchObject({ callName: "fix-bug", branch: expect.stringMatching(/^fix\/bounty-/u), taskflowReference: "actio:task-1" });
    expect(t.replies[0]!.message).toContain("採用");

    // hotfix の委託が PR を出したら記録する (PR の提出は反映ではない)。
    t.prBySession.set("child-2", "42");
    await t.flow.tick();
    expect(t.reports.find(report.id)).toMatchObject({ status: "fix_submitted", fix_pr: "42" });

    // デプロイの変更に PR が含まれたら反映済みにし、報奨を依頼する。
    const resolved = await t.flow.resolveDeployment({ project: "Cc", code: "concordia", hash: "abcdef1234567", pullRequests: [41, 42] });
    expect(resolved).toEqual([{ reportId: report.id, title: "スレッドが作られない", reporter: "neco" }]);
    expect(t.reports.find(report.id)).toMatchObject({ status: "deployed", deploy_code: "concordia", reward_state: "granted", reward_tokens: 1_000_000 });
    expect(t.rewards.requestReward).toHaveBeenCalledWith(expect.objectContaining({
      kind: "bounty", sourceRef: report.id, severity: "s2",
      recipient: { subsidiaryId: "sub_a", platform: "discord", platformUserId: USER },
    }));
    expect(t.replies.at(-1)!.message).toContain("1,000,000");
    // 同じデプロイの再送では何も起きない。
    expect(await t.flow.resolveDeployment({ project: "Cc", code: "concordia", hash: "abcdef1234567", pullRequests: [42] })).toEqual([]);
  });

  it("does not grant a reward to a head-office reporter and records why", async () => {
    const t = setup({ companyId: null });
    const report = t.submit("hq");
    await t.flow.tick();
    await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: { ...acceptedResult, hotfix_eligible: false } });
    expect(t.reports.find(report.id)!.status).toBe("fix_pending");
    expect(await t.flow.close.manualClose({ reportId: report.id, actor: "webui-admin", evidence: "本番で確認" })).toEqual({ ok: true });
    expect(t.reports.find(report.id)).toMatchObject({ status: "deployed", reward_state: "skipped", reward_note: "headquarters", close_evidence: "本番で確認" });
    expect(t.rewards.requestReward).not.toHaveBeenCalled();
  });

  it("counts invalid results and lost runs, and hands the report to an authority after three failures", async () => {
    const t = setup();
    const report = t.submit("2");
    await t.flow.tick();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: { verdict: "maybe" } });
      expect(result).toMatchObject({ ok: false, error: "invalid_result" });
    }
    const row = t.reports.find(report.id)!;
    expect(row).toMatchObject({ status: "received", triage_failures: 3 });
    expect(row.triage_escalated_at).not.toBeNull();
    expect(t.authority).toHaveLength(1);
    // 権限者へ回した報告は、自動で起動し直さない。
    await t.flow.tick();
    expect(t.launches).toHaveLength(1);
  });

  it("reconciles a launched run that ended without a result before launching again", async () => {
    const t = setup();
    const report = t.submit("3");
    await t.flow.tick();
    await t.flow.tick();
    expect(t.launches).toHaveLength(1);
    t.runs.set(t.reports.find(report.id)!.triage_run_id!, { status: "completed", childSessionId: "child-1" });
    await t.flow.tick();
    expect(t.launches).toHaveLength(2);
    expect(t.reports.find(report.id)!.triage_failures).toBe(1);
  });

  it("keeps the verdict when Actio is down, retries later, and leaves team problems to an authority", async () => {
    const t = setup({ revisorWorkflow: "github" });
    const report = t.submit("4");
    t.actioState.result = { ok: false, error: "team_ambiguous", detail: "2 teams" };
    await t.flow.tick();
    await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: acceptedResult });
    expect(t.reports.find(report.id)).toMatchObject({ status: "accepted", verdict: "accepted" });
    expect(t.reports.find(report.id)!.actio_task_error).toMatch(/^team_ambiguous:/u);
    await t.flow.tick();
    expect(t.actio.createIssueTask).toHaveBeenCalledTimes(1);
    t.actioState.result = { ok: true, taskRef: "actio:task-9" };
    expect(await t.flow.fix.retryTask(report.id)).toEqual({ ok: true, created: true });
    // github workflow のプロジェクトは hotfix にしない。
    expect(t.reports.find(report.id)).toMatchObject({ status: "fix_pending", actio_task_ref: "actio:task-9" });
  });

  it("returns a failed hotfix to fix_pending and never restarts it automatically", async () => {
    const t = setup();
    const report = t.submit("5");
    await t.flow.tick();
    await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: acceptedResult });
    const hotfixRun = t.reports.find(report.id)!.hotfix_run_id!;
    t.runs.set(hotfixRun, { status: "failed", childSessionId: "child-2" });
    await t.flow.tick();
    expect(t.reports.find(report.id)).toMatchObject({ status: "fix_pending" });
    expect(t.authority.some((message) => message.includes("hotfix"))).toBe(true);
    await t.flow.tick();
    expect(t.launches.filter((launch) => launch.callName === "fix-bug")).toHaveLength(1);
  });

  it("tells an authority once when the Actio task is done instead of closing the report", async () => {
    const t = setup({ revisorWorkflow: "github" });
    const report = t.submit("6");
    await t.flow.tick();
    await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: acceptedResult });
    t.actioState.status = "done";
    await t.flow.tick();
    await t.flow.tick();
    expect(t.reports.find(report.id)!.status).toBe("fix_pending");
    expect(t.authority.filter((message) => message.includes("done"))).toHaveLength(1);
  });
});

describe("bug-bounty judgement (SPEC-BOUNTY-APPEAL, CC-BOUNTY-INV-08)", () => {
  it("lets the reporter appeal once and an authority overturn the verdict with history", async () => {
    const t = setup({ revisorWorkflow: "github" });
    const report = t.submit("7");
    await t.flow.tick();
    await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: { verdict: "rejected", reason: "仕様どおり" } });
    const person = { kind: "person" as const, key: { subsidiary_id: "sub_a", platform: "discord", platform_user_id: USER } };
    expect(await t.flow.judgement.appeal({ reportId: report.id, actor: { kind: "person", key: { ...person.key, platform_user_id: "1" } }, reason: "x" }))
      .toEqual({ ok: false, error: "not_reporter" });
    expect(await t.flow.judgement.appeal({ reportId: report.id, actor: person, reason: "再現します" })).toEqual({ ok: true });
    expect(await t.flow.judgement.appeal({ reportId: report.id, actor: person, reason: "もう一度" })).toEqual({ ok: false, error: "appeal_used" });

    expect(await t.flow.judgement.decideAppeal({
      reportId: report.id, authority: "webui-admin", uphold: true, change: { verdict: "accepted", severity: "s3", reason: "再現した" }, reason: "再現した",
    })).toEqual({ ok: true });
    const row = t.reports.find(report.id)!;
    expect(row).toMatchObject({ verdict: "accepted", status: "fix_pending", actio_task_ref: "actio:task-1" });
    expect(row.appeal_decided_at).not.toBeNull();
    const changed = t.reports.events(report.id).find((event) => event.kind === "verdict_changed" && event.from_value?.startsWith("{"));
    expect(JSON.parse(changed!.from_value!)).toMatchObject({ verdict: "rejected" });
    expect(JSON.parse(changed!.to_value!)).toMatchObject({ verdict: "accepted", severity: "s3", reason: "再現した" });
  });

  it("revokes a granted reward when an authority marks the report self-inflicted", async () => {
    const t = setup({ revisorWorkflow: "github" });
    const report = t.submit("8");
    await t.flow.tick();
    await t.flow.triage.acceptResult({ sessionId: "child-1", reportId: report.id, raw: acceptedResult });
    await t.flow.close.manualClose({ reportId: report.id, actor: "webui-admin", evidence: "確認" });
    expect(t.reports.find(report.id)!.reward_state).toBe("granted");
    expect(await t.flow.judgement.change({ reportId: report.id, authority: "webui-admin", change: { selfInflicted: true, reason: "本人の変更が原因" } }))
      .toEqual({ ok: true });
    expect(t.rewards.revokeReward).toHaveBeenCalledWith(expect.objectContaining({ kind: "bounty", sourceRef: report.id }));
    expect(t.reports.find(report.id)!.reward_state).toBe("revoked");
  });
});
