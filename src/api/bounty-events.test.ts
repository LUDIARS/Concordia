import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BountyEventService } from "../bounty/event-service.js";
import { BountyIntakeService } from "../bounty/intake-service.js";
import { BountyEventsRepo } from "../db/bounty-events-repo.js";
import { BountyReportersRepo } from "../db/bounty-reporters-repo.js";
import { BountyReportsRepo } from "../db/bounty-reports-repo.js";
import { bountyAdminReadRouter } from "./bounty-admin.js";
import { bountyEventsAdminRouter, bountyEventsReadRouter } from "./bounty-events.js";
import { bountyRouter } from "./bounty.js";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

function setup() {
  const db = makeTestDb();
  let now = T0;
  const events = new BountyEventService({ events: new BountyEventsRepo(db), projectCodes: () => ["Cc", "At"], now: () => now });
  const reports = new BountyReportsRepo(db);
  const reporters = new BountyReportersRepo(db);
  const intake = new BountyIntakeService({
    reports, reporters,
    projects: () => [{ code: "Cc", project: "Concordia" }, { code: "At", project: "Actio" }],
    companyProjects: () => null,
    session: (id) => ({ id, active: true, companyId: null, requesterDiscordUserId: null }),
    events,
    now: () => now,
  });
  const app = new Hono();
  app.route("/v1/bounty", bountyRouter({ intake }));
  app.route("/v1/bounty", bountyAdminReadRouter({ reports, reporters, hotfixDailyLimit: () => 5 }));
  app.route("/v1/bounty", bountyEventsReadRouter({ events }));
  app.route("/v1/admin/bounty", bountyEventsAdminRouter({ events }));
  const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { send, at: (ms: number) => { now = ms; } };
}

const body = {
  title: "秋のバグ探し", starts_at: T0 + HOUR, ends_at: T0 + 3 * HOUR, projects: ["Cc"], channels: ["session", "discord"],
  guidance: "通知まわりを重点的に", reward_override: { s1: 3_000_000 },
};

describe("bounty events API (bug-bounty.md §18.3)", () => {
  it("creates, lists, edits and ends an event, with refusals carrying a reason code", async () => {
    const t = setup();
    const created = await t.send("POST", "/v1/admin/bounty/events", body);
    expect(created.status).toBe(201);
    const { event } = await created.json() as { event: { id: string } };
    expect(event).toMatchObject({ title: "秋のバグ探し", phase: "scheduled", channels: ["discord", "session"], reward_override: { s1: 3_000_000 } });

    expect((await (await t.send("GET", "/v1/bounty/events")).json() as { events: unknown[] }).events).toHaveLength(1);
    expect(await (await t.send("POST", "/v1/admin/bounty/events", { ...body, projects: ["Zz"] })).json()).toEqual({ error: "unknown_project" });
    expect((await t.send("POST", "/v1/admin/bounty/events", { ...body, extra: 1 })).status).toBe(400);

    t.at(T0 + 2 * HOUR);
    const reduced = await t.send("PATCH", `/v1/admin/bounty/events/${event.id}`, { projects: ["At"] });
    expect(reduced.status).toBe(409);
    expect(await reduced.json()).toEqual({ error: "event_projects_reduced" });
    const extended = await t.send("PATCH", `/v1/admin/bounty/events/${event.id}`, { projects: ["Cc", "At"], ends_at: T0 + 5 * HOUR });
    expect(await extended.json()).toMatchObject({ event: { projects: ["Cc", "At"], ends_at: T0 + 5 * HOUR, phase: "open" } });

    const ended = await t.send("POST", `/v1/admin/bounty/events/${event.id}/end`);
    expect(await ended.json()).toMatchObject({ event: { phase: "ended", ended_early_at: T0 + 2 * HOUR, ended_by: "webui-admin" } });
    expect((await t.send("POST", `/v1/admin/bounty/events/${event.id}/end`)).status).toBe(409);
    expect((await t.send("PATCH", "/v1/admin/bounty/events/be_missing", { title: "x" })).status).toBe(404);
  });

  it("links an intake report to the open event, refuses an inapplicable event_id and filters the report list by event", async () => {
    const t = setup();
    const { event } = await (await t.send("POST", "/v1/admin/bounty/events", body)).json() as { event: { id: string } };
    t.at(T0 + 2 * HOUR);

    const linked = await t.send("POST", "/v1/bounty/reports", { session_id: "s1", client_key: "k1", project: "Cc", what_happened: "壊れた" });
    expect(linked.status).toBe(201);
    const linkedBody = await linked.json() as { report_id: string; event: unknown; message: string };
    expect(linkedBody.event).toEqual({ id: event.id, title: "秋のバグ探し" });
    expect(linkedBody.message).toContain("バグバウンティ企画「秋のバグ探し」");

    const outside = await t.send("POST", "/v1/bounty/reports", { session_id: "s1", client_key: "k2", project: "At", what_happened: "壊れた" });
    expect(await outside.json()).toMatchObject({ event: null });

    const refused = await t.send("POST", "/v1/bounty/reports", {
      session_id: "s1", client_key: "k3", project: "At", what_happened: "壊れた", event_id: event.id,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "event_not_applicable", reason: expect.stringContaining("event_id") });

    const byEvent = await (await t.send("GET", `/v1/bounty/reports?event=${event.id}`)).json() as { reports: Array<{ id: string; event_id: string }>; total: number };
    expect(byEvent).toMatchObject({ total: 1, reports: [{ id: linkedBody.report_id, event_id: event.id }] });
    const none = await (await t.send("GET", "/v1/bounty/reports?event=none")).json() as { total: number };
    expect(none.total).toBe(1);
  });
});
