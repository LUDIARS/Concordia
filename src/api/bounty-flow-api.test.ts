import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createBountyFlow } from "../bounty/composition.js";
import type { BountyRunStatus } from "../bounty/ports.js";
import { BountyReportersRepo } from "../db/bounty-reporters-repo.js";
import { BountyReportsRepo } from "../db/bounty-reports-repo.js";
import { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { BountyIntakeService } from "../bounty/intake-service.js";
import { mountBountyRoutes } from "./bounty-routes.js";

const USER = "905235114026467350";
const MANAGER = "111111111111111111";
const BOT = "bot-token";

function setup() {
  const db = makeTestDb();
  const reports = new BountyReportsRepo(db);
  const reporters = new BountyReportersRepo(db);
  const projectCodes = new ProjectCodesRepo(db);
  projectCodes.register({ code: "Cc", project: "Concordia", repoPath: "E:/Document/Ars/Concordia", repoOrigin: "LUDIARS/Concordia", addedBy: "test" });
  projectCodes.register({ code: "At", project: "Actio", repoPath: "E:/Document/Ars/Actio", repoOrigin: "LUDIARS/Actio", addedBy: "test" });
  const runs = new Map<string, { status: BountyRunStatus; childSessionId: string | null }>();
  const flow = createBountyFlow({
    ledger: reports,
    reporters,
    projects: {
      registered: () => ["Cc", "At"],
      companyProjects: (id) => (id === null ? null : ["Cc"]),
      repoPath: (code) => projectCodes.findByCode(code)?.repo_path ?? null,
      revisorWorkflow: () => "github",
    },
    delegation: {
      launch: async (input) => { runs.set(input.runId, { status: "running", childSessionId: "triage-session" }); return { ok: true }; },
      findRun: (runId) => runs.get(runId) ?? null,
    },
    actio: { createIssueTask: async () => ({ ok: true, taskRef: "actio:t1" }), taskStatus: async () => "open" },
    prs: { prOfSession: () => null, sessionsOfTask: () => [] },
    notifier: { replyToReporter: async () => true, notifyAuthority: async () => true },
    rewards: { requestReward: () => ({ status: "granted", entry: { tokens: 500_000 } }), revokeReward: () => ({ status: "not_granted" }) },
    sessionActive: () => true,
    hotfixDailyLimit: () => 5,
  });
  const intake = new BountyIntakeService({
    reports, reporters,
    projects: () => projectCodes.list().map((row) => ({ code: row.code, project: row.project })),
    companyProjects: (id) => (id === "sub_a" ? ["Concordia"] : null),
    session: () => null,
  });
  const cocoiruKey = { value: null as string | null, isSet() { return this.value !== null; }, set(key: string | null) { this.value = key; } };
  const app = new Hono();
  mountBountyRoutes(app, {
    intake,
    verifyOperator: (platform, provided) => platform === "discord" && provided === BOT,
    flow: {
      triage: flow.triage, judgement: flow.judgement, close: flow.close, fix: flow.fix,
      isAuthority: (_platform, userId) => userId === MANAGER,
      reports, reporters, cocoiruKey,
      hotfixDailyLimit: () => 5,
      projectPublic: (code) => { const row = projectCodes.findByCode(code); return row ? row.public_issues === 1 : null; },
      publicProjects: () => projectCodes.listPublicIssues().map((row) => ({ code: row.code, project: row.project })),
    },
  });
  return { app, reports, reporters, projectCodes, flow, runs, cocoiruKey };
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const operator = { "x-concordia-bounty-operator": BOT };

async function submitAndAccept(t: ReturnType<typeof setup>, key: string, raw: Record<string, unknown>) {
  const res = await t.app.request("/v1/bounty/reports", json({
    platform: "discord", actor: { user_id: USER, subsidiary_id: "sub_a" }, client_key: key, project: "Cc",
    what_happened: "原文: スレッドが作られない", repro_steps: "原文の手順", reply_to: { channel_id: "55555" },
  }, operator));
  const { report_id: id } = await res.json() as { report_id: string };
  await t.flow.tick();
  const triage = await t.app.request(`/v1/bounty/reports/${id}/triage-result`, json({ session_id: "triage-session", result: raw }));
  return { id, triage };
}

const accepted = {
  verdict: "accepted", severity: "s3", sensitive: false, self_inflicted: false, hotfix_eligible: false,
  public_title: "スレッドが作られない", public_summary: "spawn 後にスレッドが無い", reason: "内部の判断理由",
};

describe("POST /v1/bounty/reports/:id/triage-result (bug-bounty.md §5)", () => {
  it("accepts the result from the triage session only and rejects an invalid result with 422", async () => {
    const t = setup();
    const res = await t.app.request("/v1/bounty/reports", json({
      platform: "discord", actor: { user_id: USER, subsidiary_id: "sub_a" }, client_key: "1", project: "Cc", what_happened: "x",
    }, operator));
    const { report_id: id } = await res.json() as { report_id: string };
    await t.flow.tick();
    expect((await t.app.request(`/v1/bounty/reports/${id}/triage-result`, json({ session_id: "other", result: accepted }))).status).toBe(403);
    const invalid = await t.app.request(`/v1/bounty/reports/${id}/triage-result`, json({ session_id: "triage-session", result: { verdict: "maybe" } }));
    expect(invalid.status).toBe(422);
    const ok = await t.app.request(`/v1/bounty/reports/${id}/triage-result`, json({ session_id: "triage-session", result: accepted }));
    expect(await ok.json()).toEqual({ ok: true, status: "accepted" });
  });
});

describe("appeal and close from Discord (SPEC-BOUNTY-APPEAL / SPEC-BOUNTY-CLOSE)", () => {
  it("takes an appeal with the operator key and lets only a head-office manager close", async () => {
    const t = setup();
    const rejected = await submitAndAccept(t, "2", { verdict: "rejected", reason: "対象外" });
    expect((await t.app.request(`/v1/bounty/reports/${rejected.id}/appeal`, json({
      platform: "discord", actor: { user_id: USER, subsidiary_id: "sub_a" }, reason: "再現します",
    }))).status).toBe(403);
    expect((await t.app.request(`/v1/bounty/reports/${rejected.id}/appeal`, json({
      platform: "discord", actor: { user_id: USER, subsidiary_id: "sub_a" }, reason: "再現します",
    }, operator))).status).toBe(200);

    const fixing = await submitAndAccept(t, "3", accepted);
    const close = (userId: string, subsidiary: string | null) => t.app.request(`/v1/bounty/reports/${fixing.id}/close`, json({
      platform: "discord", actor: { user_id: userId, subsidiary_id: subsidiary }, evidence: "本番で確認",
    }, operator));
    expect((await close(USER, "sub_a")).status).toBe(403);
    expect((await close(MANAGER, "sub_a")).status).toBe(403);
    expect((await close(MANAGER, null)).status).toBe(200);
    expect(t.reports.find(fixing.id)).toMatchObject({ status: "deployed", closed_by: `discord:${MANAGER}` });
  });
});

describe("admin API (bug-bounty.md §8.2)", () => {
  it("lists without the report text or history and shows them in the detail", async () => {
    const t = setup();
    const { id } = await submitAndAccept(t, "4", accepted);
    const list = await t.app.request("/v1/bounty/reports?status=fix_pending&project=Cc&company=sub_a");
    const body = await list.json() as { reports: Array<Record<string, unknown>>; total: number; hotfix_daily_limit: number };
    expect(body.total).toBe(1);
    expect(body.hotfix_daily_limit).toBe(5);
    expect(JSON.stringify(body)).not.toContain("原文");
    expect(body.reports[0]).not.toHaveProperty("events");
    const detail = await (await t.app.request(`/v1/bounty/reports/${id}`)).json() as { report: { what_happened: string; events: unknown[] } };
    expect(detail.report.what_happened).toContain("原文");
    expect(detail.report.events.length).toBeGreaterThan(1);
    expect((await t.app.request("/v1/bounty/reports?status=bogus")).status).toBe(400);
  });

  it("changes the verdict, closes and stores the Cocoiru key through use cases", async () => {
    const t = setup();
    const { id } = await submitAndAccept(t, "5", accepted);
    expect((await t.app.request(`/v1/admin/bounty/reports/${id}/judgement`, json({ severity: "s1", reason: "影響が大きい" }))).status).toBe(200);
    expect(t.reports.find(id)!.severity).toBe("s1");
    expect((await t.app.request(`/v1/admin/bounty/reports/${id}/close`, json({ evidence: "" }))).status).toBe(400);
    expect((await t.app.request(`/v1/admin/bounty/reports/${id}/close`, json({ evidence: "反映を確認" }))).status).toBe(200);
    expect((await t.app.request(`/v1/admin/bounty/reports/${id}/retry-task`, json({}))).status).toBe(409);
    const short = await t.app.request("/v1/admin/bounty/cocoiru-key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "short" }) });
    expect(short.status).toBe(400);
    const set = await t.app.request("/v1/admin/bounty/cocoiru-key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "cocoiru-0123456789abcdef" }) });
    expect(await set.json()).toEqual({ configured: true });
    expect(await (await t.app.request("/v1/admin/bounty/cocoiru-key")).json()).toEqual({ configured: true });
  });
});

describe("public read API (bug-bounty.md §8, CC-BOUNTY-INV-07)", () => {
  it("returns only §8 fields of accepted reports of public projects and never the text, intake or internal reason", async () => {
    const t = setup();
    const visible = await submitAndAccept(t, "6", accepted);
    await submitAndAccept(t, "7", { ...accepted, sensitive: true });
    await submitAndAccept(t, "8", { verdict: "rejected", reason: "対象外" });

    expect(await (await t.app.request("/v1/bounty/public-reports?project=Cc")).json()).toEqual({ project: "Cc", reports: [] });
    expect(await (await t.app.request("/v1/projects/public-issues")).json()).toEqual({ projects: [] });
    t.projectCodes.setPublicIssues("Cc", true);
    expect(await (await t.app.request("/v1/projects/public-issues")).json()).toEqual({ projects: [{ code: "Cc", project: "Concordia" }] });

    const res = await t.app.request("/v1/bounty/public-reports?project=Cc");
    const body = await res.json() as { reports: Array<Record<string, unknown>> };
    expect(body.reports.map((row) => row.report_id)).toEqual([visible.id]);
    expect(body.reports[0]).toEqual({
      report_id: visible.id, project: "Cc", title: "スレッドが作られない", summary: "spawn 後にスレッドが無い", severity: "s3",
      status: "fix_pending", reporter: "匿名", reward_tokens: null, received_at: expect.any(Number), deployed_at: null,
      actio_source_ref: visible.id,
    });
    const text = JSON.stringify(body);
    for (const secret of ["原文", "55555", USER, "内部の判断理由", "discord"]) expect(text).not.toContain(secret);
    expect((await t.app.request("/v1/bounty/public-reports?project=../etc")).status).toBe(400);
    expect(await (await t.app.request("/v1/bounty/public-reports?project=Zz")).json()).toEqual({ project: "Zz", reports: [] });
  });
});

describe("project registry public_issues toggle", () => {
  it("defaults to 0 and is set only explicitly", () => {
    const t = setup();
    expect(t.projectCodes.findByCode("Cc")!.public_issues).toBe(0);
    expect(t.projectCodes.setPublicIssues("Cc", true)!.public_issues).toBe(1);
    expect(t.projectCodes.setPublicIssues("Nope", true)).toBeNull();
    vi.restoreAllMocks();
  });
});
