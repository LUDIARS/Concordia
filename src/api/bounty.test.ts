import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BountyIntakeService, type BountySessionView } from "../bounty/intake-service.js";
import { BountyReportersRepo } from "../db/bounty-reporters-repo.js";
import { BountyReportsRepo } from "../db/bounty-reports-repo.js";
import { BOUNTY_NEEDS_INFO_MESSAGE, BOUNTY_RECEIVED_MESSAGE, bountyRouter } from "./bounty.js";

const NECO = "905235114026467350";

function makeApp() {
  const db = makeTestDb();
  const reports = new BountyReportsRepo(db);
  const sessions = new Map<string, BountySessionView>([
    ["sess-1", { id: "sess-1", active: true, companyId: null, requesterDiscordUserId: NECO }],
    ["sess-sub", { id: "sess-sub", active: true, companyId: "sub_a", requesterDiscordUserId: null }],
  ]);
  const intake = new BountyIntakeService({
    reports,
    reporters: new BountyReportersRepo(db),
    projects: () => [{ code: "Cc", project: "Concordia" }, { code: "At", project: "Actio" }],
    companyProjects: (companyId) => (companyId === "sub_a" ? ["Actio"] : null),
    session: (id) => sessions.get(id) ?? null,
    now: () => 5_000,
  });
  const app = new Hono().route("/v1/bounty", bountyRouter({ intake }));
  return { app, reports };
}

const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const discord = { platform: "discord", actor: { user_id: NECO } };
const text = { project: "Cc", what_happened: "スレッドが作られない", repro_steps: "/spawn を実行する" };

describe("POST /v1/bounty/reports (bug-bounty.md §3)", () => {
  it("accepts a session report, answers 201 without the report text and 200 for the resend", async () => {
    const { app, reports } = makeApp();
    const res = await app.request("/v1/bounty/reports", post({ session_id: "sess-1", client_key: "k1", ...text }));
    expect(res.status).toBe(201);
    const body = await res.json() as { report_id: string; created: boolean; message: string };
    expect(body).toMatchObject({
      status: "received", project: "Cc", missing: [], created: true, has_recipient: true, message: BOUNTY_RECEIVED_MESSAGE,
    });
    expect(JSON.stringify(body)).not.toContain("スレッドが作られない");
    expect(reports.find(body.report_id)?.reporter_session_id).toBe("sess-1");

    const again = await app.request("/v1/bounty/reports", post({ session_id: "sess-1", client_key: "k1", ...text }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ report_id: body.report_id, created: false });
  });

  it("accepts the operator the Bot passes and records where to answer", async () => {
    const { app, reports } = makeApp();
    const res = await app.request("/v1/bounty/reports", post({
      ...discord, client_key: "1422334455", ...text, public_name: "neco", reply_to: { guild_id: "77777", channel_id: "88888" },
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { report_id: string; reporter: string };
    expect(body.reporter).toBe("neco");
    expect(reports.find(body.report_id)).toMatchObject({ intake_key: "discord:1422334455", reporter_kind: "person" });
  });

  it("accepts a Cocoiru report under the id Cocoiru issued", async () => {
    const { app, reports } = makeApp();
    const res = await app.request("/v1/bounty/reports", post({
      platform: "cocoiru", actor: { user_id: "coco-user-9" }, client_key: "coco-report-7", ...text,
    }));
    expect(res.status).toBe(201);
    const { report_id: id } = await res.json() as { report_id: string };
    expect(reports.find(id)).toMatchObject({ intake_platform: "cocoiru", intake_key: "cocoiru:coco-report-7" });
  });

  it("asks for the description once when it is missing", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/bounty/reports", post({ session_id: "sess-1", project: "Cc" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "needs_info", missing: ["what_happened"], message: BOUNTY_NEEDS_INFO_MESSAGE });
  });

  it("answers 400 with the reason for an unknown project code and accepts project: null", async () => {
    const { app } = makeApp();
    const unknown = await app.request("/v1/bounty/reports", post({ session_id: "sess-1", ...text, project: "Zz" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unknown_project", reason: expect.stringContaining("project registry") });
    const unspecified = await app.request("/v1/bounty/reports", post({ session_id: "sess-1", ...text, project: null }));
    expect(unspecified.status).toBe(201);
    expect(await unspecified.json()).toMatchObject({ project: null });
  });

  it("keeps a subsidiary within its related projects (CC-INV-02)", async () => {
    const { app } = makeApp();
    expect((await app.request("/v1/bounty/reports", post({ session_id: "sess-sub", ...text }))).status).toBe(403);
    expect((await app.request("/v1/bounty/reports", post({ session_id: "sess-sub", ...text, project: "At" }))).status).toBe(201);
    const operator = { platform: "discord", actor: { user_id: NECO, subsidiary_id: "sub_a" }, client_key: "2001" };
    expect((await app.request("/v1/bounty/reports", post({ ...operator, ...text }))).status).toBe(403);
    expect((await app.request("/v1/bounty/reports", post({ ...operator, ...text, project: "At" }))).status).toBe(201);
  });

  it("refuses a caller that is neither a valid session nor a Bot-passed operator", async () => {
    const { app } = makeApp();
    const status = async (body: unknown) => (await app.request("/v1/bounty/reports", post(body))).status;
    expect(await status({ ...text })).toBe(400);
    expect(await status({ session_id: "sess-none", ...text })).toBe(403);
    expect(await status({ session_id: "sess-1", ...discord, ...text })).toBe(400);
    expect(await status({ platform: "discord", actor: { user_id: "not-a-snowflake" }, client_key: "1", ...text })).toBe(400);
    expect(await status({ ...discord, ...text })).toBe(400); // Discord は冪等キー (interaction id) が要る
    expect(await status({ session_id: "sess-1", ...text, unexpected: true })).toBe(400);
    expect(await status({ session_id: "sess-1", ...text, what_happened: "x".repeat(4001) })).toBe(400);
  });
});

describe("withdraw / amend / public name", () => {
  it("lets only the reporter withdraw before acceptance", async () => {
    const { app } = makeApp();
    const { report_id: id } = await (await app.request("/v1/bounty/reports",
      post({ ...discord, client_key: "1001", ...text }))).json() as { report_id: string };
    expect((await app.request(`/v1/bounty/reports/${id}/withdraw`, post({ session_id: "sess-1" }))).status).toBe(403);
    expect((await app.request(`/v1/bounty/reports/${id}/withdraw`, post({}))).status).toBe(400);
    const withdrawn = await app.request(`/v1/bounty/reports/${id}/withdraw`, post(discord));
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({ report_id: id, status: "withdrawn" });
    expect((await app.request(`/v1/bounty/reports/${id}/withdraw`, post(discord))).status).toBe(409);
    expect((await app.request("/v1/bounty/reports/br_missing/withdraw", post(discord))).status).toBe(404);
  });

  it("takes the missing description from the reporter and returns the report to triage", async () => {
    const { app } = makeApp();
    const { report_id: id } = await (await app.request("/v1/bounty/reports",
      post({ session_id: "sess-1", client_key: "k1", project: "Cc" }))).json() as { report_id: string };
    expect((await app.request(`/v1/bounty/reports/${id}/amend`, post({ session_id: "sess-1" }))).status).toBe(400);
    const amended = await app.request(`/v1/bounty/reports/${id}/amend`, post({ session_id: "sess-1", what_happened: "応答が返らない" }));
    expect(amended.status).toBe(200);
    expect(await amended.json()).toMatchObject({ status: "received", missing: [] });
    expect((await app.request(`/v1/bounty/reports/${id}/amend`, post({ session_id: "sess-1", what_happened: "再度" }))).status).toBe(409);
  });

  it("changes the caller's public name and refuses a name that could mention or link", async () => {
    const { app } = makeApp();
    const named = await app.request("/v1/bounty/reporters/public-name", post({ ...discord, public_name: "neco" }));
    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({ public_name: "neco", display: "neco" });
    const cleared = await app.request("/v1/bounty/reporters/public-name", post({ ...discord, public_name: null }));
    expect(await cleared.json()).toEqual({ public_name: null, display: "匿名" });
    const invalid = await app.request("/v1/bounty/reporters/public-name", post({ ...discord, public_name: "@everyone" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "public_name_invalid" });
    // セッションは公開名を変えられない (変更は本人だけ)。
    expect((await app.request("/v1/bounty/reporters/public-name", post({ session_id: "sess-1", public_name: "x" }))).status).toBe(400);
  });
});
