import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BountyReportersRepo } from "../db/bounty-reporters-repo.js";
import { BountyReportsRepo } from "../db/bounty-reports-repo.js";
import { BountyIntakeService, type BountyActor, type BountySessionView } from "./intake-service.js";

const NECO = "905235114026467350";
const OTHER = "111111111111";

function setup() {
  const db = makeTestDb();
  const reports = new BountyReportsRepo(db);
  const reporters = new BountyReportersRepo(db);
  const sessions = new Map<string, BountySessionView>([
    ["sess-hq", { id: "sess-hq", active: true, companyId: null, requesterDiscordUserId: null }],
    ["sess-sub", { id: "sess-sub", active: true, companyId: "sub_a", requesterDiscordUserId: NECO }],
    ["sess-ended", { id: "sess-ended", active: false, companyId: null, requesterDiscordUserId: NECO }],
    ["sess-orphan", { id: "sess-orphan", active: true, companyId: "sub_gone", requesterDiscordUserId: null }],
  ]);
  let now = 1_000;
  const service = new BountyIntakeService({
    reports,
    reporters,
    projects: () => [{ code: "Cc", project: "Concordia" }, { code: "At", project: "Actio" }],
    companyProjects: (companyId) => (companyId === "sub_a" ? ["Actio"] : null),
    session: (id) => sessions.get(id) ?? null,
    now: () => now,
  });
  return { service, reports, reporters, tick: () => { now += 10; } };
}

const discord = (userId = NECO, companyId: string | null = null): BountyActor =>
  ({ kind: "operator", platform: "discord", companyId, platformUserId: userId });
const session = (sessionId: string): BountyActor => ({ kind: "session", sessionId });
const report = { project: "Cc", whatHappened: "スレッドが作られない", reproSteps: "/spawn を実行する" };

describe("BountyIntakeService.submit (bug-bounty.md §3)", () => {
  it("persists a Discord report and returns a receipt without the report text", () => {
    const { service, reports, reporters } = setup();
    const result = service.submit({
      actor: discord(), clientKey: "1001", ...report, publicName: "neco", replyTo: { guild_id: "77777", channel_id: "88888" },
    });
    expect(result).toMatchObject({
      ok: true, created: true,
      receipt: { status: "received", project: "Cc", missing: [], reporter: "neco", has_recipient: true },
    });
    if (!result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.receipt)).not.toContain("スレッドが作られない");
    const row = reports.find(result.receipt.id)!;
    const reporter = reporters.findByKey({ subsidiary_id: null, platform: "discord", platform_user_id: NECO })!;
    expect(row).toMatchObject({
      reporter_kind: "person", reporter_id: reporter.id, recipient_reporter_id: reporter.id, reporter_session_id: null,
      intake_platform: "discord", intake_key: "discord:1001", what_happened: "スレッドが作られない",
    });
    expect(JSON.parse(row.intake_ref_json)).toEqual({ guild_id: "77777", channel_id: "88888" });
    expect(reports.events(row.id)).toEqual([expect.objectContaining({ kind: "received", actor_kind: "human", actor_id: reporter.id })]);
  });

  it("returns the same report for a resend and changes nothing (CC-BOUNTY-INV-02 / 03)", () => {
    const { service, reports, reporters } = setup();
    const first = service.submit({ actor: discord(), clientKey: "1001", ...report, publicName: "neco" });
    const again = service.submit({
      actor: discord(), clientKey: "1001", project: "Zz", whatHappened: "別の本文", reproSteps: "", publicName: "別名",
    });
    if (!first.ok || !again.ok) throw new Error("unreachable");
    expect(again.created).toBe(false);
    expect(again.receipt.id).toBe(first.receipt.id);
    expect(reports.find(first.receipt.id)).toMatchObject({ project_code: "Cc", what_happened: "スレッドが作られない" });
    expect(reports.events(first.receipt.id)).toHaveLength(1);
    expect(reporters.findByKey({ subsidiary_id: null, platform: "discord", platform_user_id: NECO })?.public_name).toBe("neco");
  });

  it("keeps the public name when the report leaves it blank and shows 匿名 when none is set", () => {
    const { service } = setup();
    const anonymous = service.submit({ actor: discord(), clientKey: "1001", ...report });
    expect(anonymous).toMatchObject({ ok: true, receipt: { reporter: "匿名" } });
    service.setPublicName({ companyId: null, platform: "discord", platformUserId: NECO, publicName: "neco" });
    const named = service.submit({ actor: discord(), clientKey: "1002", ...report, publicName: "" });
    expect(named).toMatchObject({ ok: true, receipt: { reporter: "neco" } });
  });

  it("accepts a report without the description as needs_info and one without a project as unknown", () => {
    const { service } = setup();
    expect(service.submit({ actor: discord(), clientKey: "1001", project: "Cc", whatHappened: " ", reproSteps: "" }))
      .toMatchObject({ ok: true, receipt: { status: "needs_info", missing: ["what_happened"] } });
    expect(service.submit({ actor: discord(), clientKey: "1002", project: null, whatHappened: "壊れている", reproSteps: "" }))
      .toMatchObject({ ok: true, receipt: { status: "received", project: null } });
  });

  it("refuses an unknown project, a missing key, an invalid name and an oversized text before writing", () => {
    const { service, reports } = setup();
    expect(service.submit({ actor: discord(), clientKey: "1001", ...report, project: "Zz" }))
      .toEqual({ ok: false, error: "unknown_project" });
    expect(service.submit({ actor: discord(), clientKey: null, ...report })).toEqual({ ok: false, error: "client_key_required" });
    expect(service.submit({ actor: discord(), clientKey: "1001", ...report, publicName: "@everyone" }))
      .toEqual({ ok: false, error: "public_name_invalid" });
    expect(service.submit({ actor: discord(), clientKey: "1001", ...report, whatHappened: "x".repeat(4001) }))
      .toEqual({ ok: false, error: "text_too_long" });
    expect(reports.findByIntakeKey("discord:1001")).toBeNull();
  });

  it("limits a subsidiary to its related projects and refuses an unregistered company (CC-INV-02)", () => {
    const { service, reports } = setup();
    expect(service.submit({ actor: discord(NECO, "sub_a"), clientKey: "1001", ...report }))
      .toEqual({ ok: false, error: "project_outside_company_scope" });
    const inScope = service.submit({ actor: discord(NECO, "sub_a"), clientKey: "1002", ...report, project: "At" });
    expect(inScope).toMatchObject({ ok: true, receipt: { project: "At" } });
    if (!inScope.ok) throw new Error("unreachable");
    expect(reports.find(inScope.receipt.id)?.subsidiary_id).toBe("sub_a");
    expect(service.submit({ actor: discord(NECO, "sub_missing"), clientKey: "1003", ...report }))
      .toEqual({ ok: false, error: "unknown_company" });
  });

  it("takes a session report from any live session and names its requester as the recipient", () => {
    const { service, reports, reporters } = setup();
    const result = service.submit({ actor: session("sess-sub"), clientKey: null, ...report, project: "At", publicName: "勝手な名前" });
    expect(result).toMatchObject({ ok: true, receipt: { reporter: "AI セッション (依頼者: 匿名)", has_recipient: true } });
    if (!result.ok) throw new Error("unreachable");
    const row = reports.find(result.receipt.id)!;
    const requester = reporters.findByKey({ subsidiary_id: "sub_a", platform: "discord", platform_user_id: NECO })!;
    expect(row).toMatchObject({
      reporter_kind: "session", reporter_id: null, reporter_session_id: "sess-sub", recipient_reporter_id: requester.id,
      subsidiary_id: "sub_a", intake_platform: "session",
    });
    // セッションは依頼者の公開名を決められない (変更は本人だけ)。
    expect(requester.public_name).toBeNull();
    expect(JSON.parse(row.intake_ref_json)).toEqual({ session_id: "sess-sub" });
    expect(reports.events(row.id)[0]).toMatchObject({ actor_kind: "ai", actor_id: "sess-sub" });
    // 同じセッションが同じ本文を出し直しても 1 件 (client_key 無しは本文のハッシュ)。
    expect(service.submit({ actor: session("sess-sub"), clientKey: null, ...report, project: "At" }))
      .toMatchObject({ ok: true, created: false, receipt: { id: result.receipt.id } });
    expect(service.submit({ actor: session("sess-sub"), clientKey: null, ...report }))
      .toEqual({ ok: false, error: "project_outside_company_scope" });
  });

  it("records no recipient when the session's requester cannot be identified (CC-BOUNTY-INV-05)", () => {
    const { service, reports } = setup();
    const result = service.submit({ actor: session("sess-hq"), clientKey: "k1", ...report });
    expect(result).toMatchObject({ ok: true, receipt: { has_recipient: false, reporter: "AI セッション (依頼者: 匿名)" } });
    if (!result.ok) throw new Error("unreachable");
    expect(reports.find(result.receipt.id)?.recipient_reporter_id).toBeNull();
  });

  it("closes the scope of a session whose company is no longer registered instead of treating it as head office", () => {
    const { service } = setup();
    expect(service.submit({ actor: session("sess-orphan"), clientKey: "k1", ...report }))
      .toEqual({ ok: false, error: "project_outside_company_scope" });
    expect(service.submit({ actor: session("sess-orphan"), clientKey: "k2", ...report, project: null }))
      .toMatchObject({ ok: true, receipt: { project: null, has_recipient: false } });
  });

  it("refuses an unknown or ended session", () => {
    const { service } = setup();
    expect(service.submit({ actor: session("sess-none"), clientKey: null, ...report })).toEqual({ ok: false, error: "invalid_session" });
    expect(service.submit({ actor: session("sess-ended"), clientKey: null, ...report })).toEqual({ ok: false, error: "invalid_session" });
  });
});

describe("BountyIntakeService.withdraw (bug-bounty.md §9)", () => {
  it("lets only the reporter withdraw, once, before acceptance", () => {
    const { service, reports, tick } = setup();
    const submitted = service.submit({ actor: discord(), clientKey: "1001", ...report });
    if (!submitted.ok) throw new Error("unreachable");
    const id = submitted.receipt.id;
    expect(service.withdraw({ reportId: id, actor: discord(OTHER) })).toEqual({ ok: false, error: "not_reporter" });
    // 同じユーザー id でも別の会社の人は別人。
    expect(service.withdraw({ reportId: id, actor: discord(NECO, "sub_a") })).toEqual({ ok: false, error: "not_reporter" });
    expect(service.withdraw({ reportId: id, actor: session("sess-hq") })).toEqual({ ok: false, error: "not_reporter" });
    tick();
    expect(service.withdraw({ reportId: id, actor: discord() })).toMatchObject({ ok: true, receipt: { status: "withdrawn" } });
    expect(reports.find(id)).toMatchObject({ status: "withdrawn", withdrawn_at: 1_010 });
    expect(service.withdraw({ reportId: id, actor: discord() })).toEqual({ ok: false, error: "already_decided" });
    expect(reports.events(id).map((event) => event.kind)).toEqual(["received", "withdrawn"]);
    expect(service.withdraw({ reportId: "br_missing", actor: discord() })).toEqual({ ok: false, error: "report_not_found" });
  });

  it("refuses withdrawal after triage accepted the report", () => {
    const { service, reports } = setup();
    const submitted = service.submit({ actor: session("sess-sub"), clientKey: "k1", ...report, project: "At" });
    if (!submitted.ok) throw new Error("unreachable");
    reports.transition({
      id: submitted.receipt.id, from: "received", to: "accepted", event: { kind: "triage_result", actor_kind: "ai" },
    });
    expect(service.withdraw({ reportId: submitted.receipt.id, actor: session("sess-sub") }))
      .toEqual({ ok: false, error: "already_decided" });
  });
});

describe("BountyIntakeService.amend", () => {
  it("returns a needs_info report to triage with the added text and keeps the original", () => {
    const { service, reports } = setup();
    const submitted = service.submit({ actor: discord(), clientKey: "1001", project: "Cc", whatHappened: "", reproSteps: "手順 A" });
    if (!submitted.ok) throw new Error("unreachable");
    const id = submitted.receipt.id;
    expect(service.amend({ reportId: id, actor: discord(OTHER), whatHappened: "x", reproSteps: "" }))
      .toEqual({ ok: false, error: "not_reporter" });
    expect(service.amend({ reportId: id, actor: discord(), whatHappened: " ", reproSteps: "" }))
      .toEqual({ ok: false, error: "amendment_empty" });
    // 「何が起きたか」が空のままでは仕分けへ戻せない。
    expect(service.amend({ reportId: id, actor: discord(), whatHappened: "", reproSteps: "手順 B" }))
      .toEqual({ ok: false, error: "amendment_empty" });
    expect(service.amend({ reportId: id, actor: discord(), whatHappened: "応答が返らない", reproSteps: "手順 B" }))
      .toMatchObject({ ok: true, receipt: { status: "received", missing: [] } });
    expect(reports.find(id)).toMatchObject({
      status: "received", what_happened: "応答が返らない", repro_steps: "手順 A\n\n[追記]\n手順 B",
    });
    expect(reports.events(id).map((event) => [event.kind, event.from_value, event.to_value])).toEqual([
      ["received", null, "needs_info"],
      ["amended", "needs_info", "received"],
    ]);
    expect(service.amend({ reportId: id, actor: discord(), whatHappened: "もう一度", reproSteps: "" }))
      .toEqual({ ok: false, error: "not_awaiting_info" });
  });
});

describe("BountyIntakeService.setPublicName (bug-bounty.md §4)", () => {
  it("changes only the caller's own row and validates the name", () => {
    const { service, reporters } = setup();
    expect(service.setPublicName({ companyId: null, platform: "discord", platformUserId: NECO, publicName: " neco " }))
      .toEqual({ ok: true, publicName: "neco", display: "neco" });
    expect(service.setPublicName({ companyId: null, platform: "discord", platformUserId: OTHER, publicName: null }))
      .toEqual({ ok: true, publicName: null, display: "匿名" });
    expect(reporters.findByKey({ subsidiary_id: null, platform: "discord", platform_user_id: NECO })?.public_name).toBe("neco");
    expect(service.setPublicName({ companyId: null, platform: "discord", platformUserId: NECO, publicName: "<@1>" }))
      .toEqual({ ok: false, error: "public_name_invalid" });
    expect(service.setPublicName({ companyId: "sub_missing", platform: "discord", platformUserId: NECO, publicName: "x" }))
      .toEqual({ ok: false, error: "unknown_company" });
  });
});
