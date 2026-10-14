import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BountyEventsRepo } from "../db/bounty-events-repo.js";
import { BountyReportersRepo } from "../db/bounty-reporters-repo.js";
import { BountyReportsRepo } from "../db/bounty-reports-repo.js";
import { openBountyEventNotices } from "./event-notice.js";
import { BountyEventService } from "./event-service.js";
import { BountyIntakeService } from "./intake-service.js";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const NECO = "905235114026467350";

function setup() {
  const db = makeTestDb();
  let now = T0;
  const events = new BountyEventService({ events: new BountyEventsRepo(db), projectCodes: () => ["Cc", "Ar", "At"], now: () => now });
  const reports = new BountyReportsRepo(db);
  const intake = new BountyIntakeService({
    reports,
    reporters: new BountyReportersRepo(db),
    projects: () => [{ code: "Cc", project: "Concordia" }, { code: "Ar", project: "Ars" }, { code: "At", project: "Actio" }],
    companyProjects: () => null,
    session: (id) => ({ id, active: true, companyId: null, requesterDiscordUserId: null }),
    events,
    now: () => now,
  });
  return { db, events, reports, intake, at: (ms: number) => { now = ms; } };
}

const draft = {
  title: "秋のバグ探し", startsAt: T0 + HOUR, endsAt: T0 + 3 * HOUR, projects: ["Cc"], channels: ["discord", "session"],
  guidance: "通知まわりを重点的に", rewardOverride: { s2: 700_000 },
};

describe("BountyEventService (bug-bounty.md §0 §8.2 §18)", () => {
  it("creates, lists with phases, edits and ends an event early", () => {
    const { events, at } = setup();
    const created = events.create(draft, "webui-admin");
    if (!created.ok) throw new Error(created.error);
    expect(created.event).toMatchObject({ title: "秋のバグ探し", phase: "scheduled", createdBy: "webui-admin", rewardOverride: { s2: 700_000 } });
    expect(events.openAt()).toEqual([]);

    at(T0 + 2 * HOUR);
    expect(events.list().map((event) => event.phase)).toEqual(["open"]);
    expect(events.update(created.event.id, { projects: [] })).toEqual({ ok: false, error: "projects_invalid" });
    expect(events.update(created.event.id, { projects: ["Ar"] })).toEqual({ ok: false, error: "event_projects_reduced" });
    expect(events.update(created.event.id, { projects: ["Cc", "Ar"] })).toMatchObject({ ok: true, event: { projects: ["Cc", "Ar"] } });

    const ended = events.endEarly(created.event.id, "webui-admin");
    expect(ended).toMatchObject({ ok: true, event: { phase: "ended", endedEarlyAt: T0 + 2 * HOUR, endedBy: "webui-admin" } });
    expect(events.openAt()).toEqual([]);
    expect(events.endEarly(created.event.id, "webui-admin")).toEqual({ ok: false, error: "event_ended" });
    expect(events.update(created.event.id, { title: "延長" })).toEqual({ ok: false, error: "event_ended" });
    expect(events.update("be_missing", { title: "x" })).toEqual({ ok: false, error: "event_not_found" });
  });

  it("links reports to the open event at intake and still accepts reports outside it (CC-BOUNTY-INV-11)", () => {
    const { events, reports, intake, at } = setup();
    const created = events.create(draft, "webui-admin");
    if (!created.ok) throw new Error(created.error);

    // 開始前: 企画なしで受け付ける。
    const before = intake.submit({ actor: { kind: "session", sessionId: "s1" }, clientKey: "k1", project: "Cc", whatHappened: "壊れた", reproSteps: "" });
    expect(before).toMatchObject({ ok: true, receipt: { event: null } });

    at(T0 + 2 * HOUR);
    const linked = intake.submit({ actor: { kind: "session", sessionId: "s1" }, clientKey: "k2", project: "Cc", whatHappened: "壊れた", reproSteps: "" });
    expect(linked).toMatchObject({ ok: true, receipt: { event: { id: created.event.id, title: "秋のバグ探し" } } });
    if (!linked.ok) throw new Error("unreachable");
    expect(reports.find(linked.receipt.id)?.event_id).toBe(created.event.id);

    // 対象外のプロジェクト・受付口・不明なプロジェクトは企画なしで受け付ける。
    const other = intake.submit({ actor: { kind: "session", sessionId: "s1" }, clientKey: "k3", project: "At", whatHappened: "壊れた", reproSteps: "" });
    expect(other).toMatchObject({ ok: true, receipt: { event: null } });
    const cocoiru = intake.submit({
      actor: { kind: "operator", platform: "cocoiru", companyId: null, platformUserId: "u-1" }, clientKey: "c1", project: "Cc",
      whatHappened: "壊れた", reproSteps: "",
    });
    expect(cocoiru).toMatchObject({ ok: true, receipt: { event: null } });
    const unknown = intake.submit({ actor: { kind: "session", sessionId: "s1" }, clientKey: "k4", project: null, whatHappened: "壊れた", reproSteps: "" });
    expect(unknown).toMatchObject({ ok: true, receipt: { event: null } });

    // 指定した企画が当たらなければ拒む。
    expect(intake.submit({
      actor: { kind: "session", sessionId: "s1" }, clientKey: "k5", project: "At", whatHappened: "壊れた", reproSteps: "", eventId: created.event.id,
    })).toEqual({ ok: false, error: "event_not_applicable" });

    // 再送は最初の受付のまま (企画が終わっても付け替えない)。
    at(T0 + 4 * HOUR);
    const resent = intake.submit({ actor: { kind: "session", sessionId: "s1" }, clientKey: "k2", project: "Cc", whatHappened: "壊れた", reproSteps: "" });
    expect(resent).toMatchObject({ ok: true, created: false, receipt: { event: { id: created.event.id } } });
    const after = intake.submit({
      actor: { kind: "operator", platform: "discord", companyId: null, platformUserId: NECO }, clientKey: "d1", project: "Cc",
      whatHappened: "壊れた", reproSteps: "",
    });
    expect(after).toMatchObject({ ok: true, receipt: { event: null } });

    expect(reports.list({ event: created.event.id }, 50, 0).rows.map((row) => row.id)).toEqual([linked.receipt.id]);
    expect(reports.list({ event: "" }, 50, 0).total).toBe(5);
  });

  it("hands open events to the guidance and treats an unreadable source as no event", () => {
    const { events, at } = setup();
    events.create(draft, "webui-admin");
    at(T0 + 2 * HOUR);
    expect(openBountyEventNotices(events)).toEqual([expect.objectContaining({
      title: "秋のバグ探し", projects: ["Cc"], guidance: "通知まわりを重点的に", startsAt: T0 + HOUR, endsAt: T0 + 3 * HOUR,
    })]);
    expect(openBountyEventNotices({ openAt: () => { throw new Error("db closed"); } })).toEqual([]);
  });
});
