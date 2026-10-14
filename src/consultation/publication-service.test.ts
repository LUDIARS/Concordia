import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConsultationPublicationsRepo } from "../db/consultation-publications-repo.js";
import { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import { createPersonalBudget } from "../personal-budget/composition.js";
import type { ConsultationRewardPort } from "./publication-reward.js";
import { PublicationService } from "./publication-service.js";
import { TabulaImportError } from "./tabula-client.js";

function setup(options: {
  tabula?: boolean;
  importFails?: boolean;
  subsidiaryId?: string | null;
  rewards?: ConsultationRewardPort | null;
} = {}) {
  const db = makeTestDb();
  const consultations = new PrivateConsultationsRepo(db);
  const publications = new ConsultationPublicationsRepo(db);
  const consultation = consultations.create({
    subsidiary_id: options.subsidiaryId ?? null, department_id: "dept_qa", requester_user_id: "111", status: "pending_approval", intake_json: "{}",
  });
  consultations.markOpen(consultation.id, "111");
  consultations.setSession(consultation.id, "sess-1");
  consultations.addMember({ consultation_id: consultation.id, platform_user_id: "111", reason: "requester", added_by: "111" });
  consultations.addMember({ consultation_id: consultation.id, platform_user_id: "900", reason: "approver", added_by: "system" });
  const importPage = vi.fn(async () => {
    if (options.importFails) throw new TabulaImportError("unreachable", null);
    return { pageId: "page-1", url: "https://tabula/#page=page-1" };
  });
  const service = new PublicationService({
    publications,
    consultations,
    departmentName: () => "技術相談課",
    tabulaConnection: () => (options.tabula === false ? null : { url: "http://tabula", token: "t" }),
    importPage,
    rewards: () => options.rewards ?? null,
    log: { warn: vi.fn() },
  });
  return { db, service, consultations, publications, consultation, importPage };
}

describe("PublicationService.propose", () => {
  it("accepts a rewritten summary from the consultation's session", () => {
    const { service, consultation } = setup();
    const proposed = service.propose({ sessionId: "sess-1", title: "集約の切り方", summary: "不変条件の単位で切る" });
    expect(proposed).toMatchObject({ ok: true, tabulaReady: true, consultation: { id: consultation.id } });
  });

  it("rejects other sessions, closed consultations and empty proposals", () => {
    const { service, consultations, consultation } = setup();
    expect(service.propose({ sessionId: "sess-x", title: "a", summary: "b" })).toEqual({ ok: false, error: "consultation_not_found" });
    expect(service.propose({ sessionId: "sess-1", title: " ", summary: "b" })).toEqual({ ok: false, error: "invalid_proposal" });
    consultations.markClosed(consultation.id);
    expect(service.propose({ sessionId: "sess-1", title: "a", summary: "b" })).toEqual({ ok: false, error: "consultation_not_open" });
  });
});

describe("PublicationService share on close (tech-consultation.md §7)", () => {
  it("asks to share only after the consultation is closed", () => {
    const { service, consultations, consultation } = setup();
    expect(service.proposeOnClose({ consultationId: consultation.id, title: "T", summary: "S" }))
      .toEqual({ ok: false, error: "consultation_not_closed" });
    consultations.markClosed(consultation.id);
    expect(service.proposeOnClose({ consultationId: consultation.id, title: "T", summary: "S" }))
      .toMatchObject({ ok: true, consultation: { id: consultation.id }, publication: { status: "proposed" } });
    expect(service.proposeOnClose({ consultationId: "pc_missing", title: "T", summary: "S" }))
      .toEqual({ ok: false, error: "consultation_not_found" });
  });

  it("treats no answer as 'do not share' once", () => {
    const { service, consultations, consultation } = setup();
    consultations.markClosed(consultation.id);
    const asked = service.proposeOnClose({ consultationId: consultation.id, title: "T", summary: "S" });
    if (!asked.ok) throw new Error(asked.error);
    expect(service.expire(asked.publication.id)).toMatchObject({ ok: true, publication: { status: "declined", decided_by: "timeout" } });
    expect(service.expire(asked.publication.id)).toEqual({ ok: false, error: "not_proposed" });
  });
});

describe("PublicationService decisions (CC-CONSULT-INV-04)", () => {
  function proposed(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(options);
    const result = ctx.service.propose({ sessionId: "sess-1", title: "集約の切り方", summary: "不変条件の単位で切る" });
    if (!result.ok) throw new Error(result.error);
    return { ...ctx, id: result.publication.id };
  }

  it("publishes only for the requester, with the edited text and department tags", async () => {
    const { service, id, importPage } = proposed();
    expect(await service.publish({ publicationId: id, actorUserId: "900" })).toEqual({ ok: false, error: "not_requester" });
    const published = await service.publish({ publicationId: id, actorUserId: "111", editedSummary: "直した要約" });
    expect(published).toMatchObject({ ok: true, publication: { status: "published", tabula_url: "https://tabula/#page=page-1" } });
    expect(importPage).toHaveBeenCalledWith(expect.anything(), {
      key: `concordia-consultation:${id}`, title: "集約の切り方", text: "直した要約", tags: ["技術相談", "技術相談課"],
    });
    expect(await service.publish({ publicationId: id, actorUserId: "111" })).toEqual({ ok: false, error: "not_proposed" });
  });

  it("keeps the proposal when Tabula fails or is not configured", async () => {
    const failing = proposed({ importFails: true });
    expect(await failing.service.publish({ publicationId: failing.id, actorUserId: "111" })).toEqual({ ok: false, error: "tabula_failed" });
    expect(failing.publications.find(failing.id)).toMatchObject({ status: "proposed", last_error: expect.stringContaining("unreachable") });

    const unset = proposed({ tabula: false });
    expect(await unset.service.publish({ publicationId: unset.id, actorUserId: "111" })).toEqual({ ok: false, error: "tabula_not_configured" });
  });

  it("lets the requester decline and approvers only withdraw", () => {
    const first = proposed();
    expect(first.service.decline(first.id, "900")).toEqual({ ok: false, error: "not_requester" });
    expect(first.service.decline(first.id, "111")).toMatchObject({ ok: true, publication: { status: "declined" } });

    const second = proposed();
    expect(second.service.withdraw(second.id, "111")).toEqual({ ok: false, error: "not_approver" });
    expect(second.service.withdraw(second.id, "900")).toMatchObject({ ok: true, publication: { status: "withdrawn", decided_by: "900" } });
  });
});

describe("PublicationService publication reward (personal-ai-budget.md §4 tabula)", () => {
  function proposed(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(options);
    const result = ctx.service.propose({ sessionId: "sess-1", title: "集約の切り方", summary: "不変条件の単位で切る" });
    if (!result.ok) throw new Error(result.error);
    return { ...ctx, id: result.publication.id };
  }

  function fakeRewards() {
    const requestReward = vi.fn<ConsultationRewardPort["requestReward"]>(() => ({ status: "granted", entry: { tokens: 300_000 } }));
    return { requestReward };
  }

  it("asks the budget port once for the requester after the Tabula post succeeds", async () => {
    const rewards = fakeRewards();
    const { service, id } = proposed({ subsidiaryId: "glab", rewards });
    expect(await service.publish({ publicationId: id, actorUserId: "111" })).toMatchObject({ ok: true });
    expect(rewards.requestReward).toHaveBeenCalledTimes(1);
    expect(rewards.requestReward).toHaveBeenCalledWith({
      kind: "tabula", sourceRef: id, recipient: { subsidiaryId: "glab", platform: "discord", platformUserId: "111" },
    });
    // 2 回目の公開は not_proposed で止まり、 依頼も増えない。
    expect(await service.publish({ publicationId: id, actorUserId: "111" })).toEqual({ ok: false, error: "not_proposed" });
    expect(rewards.requestReward).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the post fails, Tabula is not configured, or the requester declines / an approver withdraws", async () => {
    const failingRewards = fakeRewards();
    const failing = proposed({ importFails: true, subsidiaryId: "glab", rewards: failingRewards });
    await failing.service.publish({ publicationId: failing.id, actorUserId: "111" });
    const unsetRewards = fakeRewards();
    const unset = proposed({ tabula: false, subsidiaryId: "glab", rewards: unsetRewards });
    await unset.service.publish({ publicationId: unset.id, actorUserId: "111" });
    const notRequesterRewards = fakeRewards();
    const notRequester = proposed({ subsidiaryId: "glab", rewards: notRequesterRewards });
    await notRequester.service.publish({ publicationId: notRequester.id, actorUserId: "900" });
    const declinedRewards = fakeRewards();
    const declined = proposed({ subsidiaryId: "glab", rewards: declinedRewards });
    declined.service.decline(declined.id, "111");
    const withdrawnRewards = fakeRewards();
    const withdrawn = proposed({ subsidiaryId: "glab", rewards: withdrawnRewards });
    withdrawn.service.withdraw(withdrawn.id, "900");
    for (const rewards of [failingRewards, unsetRewards, notRequesterRewards, declinedRewards, withdrawnRewards]) {
      expect(rewards.requestReward).not.toHaveBeenCalled();
    }
  });

  it("keeps the publication when the reward request throws", async () => {
    const rewards = { requestReward: vi.fn(() => { throw new Error("db locked"); }) };
    const { service, id, publications } = proposed({ subsidiaryId: "glab", rewards });
    expect(await service.publish({ publicationId: id, actorUserId: "111" })).toMatchObject({ ok: true });
    expect(publications.find(id)).toMatchObject({ status: "published" });
  });

  it("grants a subsidiary requester once through the real ledger and skips a head-office requester", async () => {
    const subsidiary = setup({ subsidiaryId: "glab" });
    const budget = createPersonalBudget({
      db: subsidiary.db, subsidiaryMonthlyDefault: () => 0, isGlobalOver: () => false, readSetting: () => null,
    });
    const wired = new PublicationService({
      publications: subsidiary.publications,
      consultations: subsidiary.consultations,
      departmentName: () => "技術相談課",
      tabulaConnection: () => ({ url: "http://tabula", token: "t" }),
      importPage: subsidiary.importPage,
      rewards: () => budget.rewards,
    });
    const proposal = wired.propose({ sessionId: "sess-1", title: "T", summary: "S" });
    if (!proposal.ok) throw new Error(proposal.error);
    expect(await wired.publish({ publicationId: proposal.publication.id, actorUserId: "111" })).toMatchObject({ ok: true });
    const person = budget.people.find({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" })!;
    expect(budget.ledger.balance(person.id)).toBe(300_000);
    expect(budget.ledger.findBySource("grant", "tabula", proposal.publication.id)).toMatchObject({ tokens: 300_000 });

    const hq = setup({ subsidiaryId: null });
    const hqBudget = createPersonalBudget({
      db: hq.db, subsidiaryMonthlyDefault: () => 0, isGlobalOver: () => false, readSetting: () => null,
    });
    const hqProposal = hq.service.propose({ sessionId: "sess-1", title: "T", summary: "S" });
    if (!hqProposal.ok) throw new Error(hqProposal.error);
    const hqService = new PublicationService({
      publications: hq.publications,
      consultations: hq.consultations,
      departmentName: () => null,
      tabulaConnection: () => ({ url: "http://tabula", token: "t" }),
      importPage: hq.importPage,
      rewards: () => hqBudget.rewards,
    });
    expect(await hqService.publish({ publicationId: hqProposal.publication.id, actorUserId: "111" })).toMatchObject({ ok: true });
    expect(hqBudget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });
});
