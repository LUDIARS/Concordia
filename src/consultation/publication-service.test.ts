import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConsultationPublicationsRepo } from "../db/consultation-publications-repo.js";
import { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import { PublicationService } from "./publication-service.js";
import { TabulaImportError } from "./tabula-client.js";

function setup(options: { tabula?: boolean; importFails?: boolean } = {}) {
  const db = makeTestDb();
  const consultations = new PrivateConsultationsRepo(db);
  const publications = new ConsultationPublicationsRepo(db);
  const consultation = consultations.create({
    subsidiary_id: null, department_id: "dept_qa", requester_user_id: "111", status: "pending_approval", intake_json: "{}",
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
  });
  return { service, consultations, publications, consultation, importPage };
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
