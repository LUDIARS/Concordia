import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DepartmentsRepo } from "../db/departments-repo.js";
import { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import { DepartmentSettingsSchema } from "../departments/settings.js";
import { PrivateConsultationService } from "./private-consultation-service.js";

const intake = { topic: "評価面談の伝え方", skill_level: "初級", role_title: "マネージャー", purpose: "" };

function setup(options: { launchers?: string[]; privateSetting?: Record<string, unknown>; subsidiary?: string | null } = {}) {
  const db = makeTestDb();
  const departments = new DepartmentsRepo(db);
  const store = new PrivateConsultationsRepo(db);
  const department = departments.create({
    subsidiary_id: options.subsidiary ?? null,
    name: "技術相談課",
    slug: "tech-consulting",
    settings: DepartmentSettingsSchema.parse({ private: options.privateSetting ?? { enabled: true } }),
  });
  const roster: Record<string, "manager" | "executive"> = { "900": "manager", "901": "executive" };
  const launchers = new Set(options.launchers ?? ["900", "901"]);
  let clock = 100;
  const service = new PrivateConsultationService({
    store,
    department: (id) => departments.find(id),
    approvers: (minRole) => Object.entries(roster)
      .filter(([, role]) => minRole === "manager" || role === "executive")
      .map(([id]) => id),
    canLaunch: (userId) => launchers.has(userId),
    now: () => clock++,
  });
  return { service, store, department, departments };
}

describe("PrivateConsultationService.start", () => {
  it("opens a consultation for a requester who may launch and adds the approvers as viewers", () => {
    const { service, department } = setup({ launchers: ["900", "901", "111"] });
    const started = service.start({ departmentId: department.id, runtimeSubsidiaryId: null, requesterUserId: "111", intake });
    if (!started.ok) throw new Error(started.error);
    expect(started.needsApproval).toBe(false);
    expect(started.consultation).toMatchObject({ status: "open", approved_by: "111", requester_user_id: "111" });
    expect(started.members.map((m) => [m.platform_user_id, m.reason])).toEqual([
      ["111", "requester"], ["900", "approver"], ["901", "approver"],
    ]);
    expect(service.intakeOf(started.consultation)).toEqual(intake);
  });

  it("waits for approval when the requester cannot launch, limited to executives when configured", () => {
    const { service, department } = setup({ privateSetting: { enabled: true, approver_min_role: "executive" } });
    const started = service.start({ departmentId: department.id, runtimeSubsidiaryId: null, requesterUserId: "111", intake });
    if (!started.ok) throw new Error(started.error);
    expect(started.needsApproval).toBe(true);
    expect(started.consultation.status).toBe("pending_approval");
    expect(started.members.map((m) => m.platform_user_id)).toEqual(["111", "901"]);
  });

  it("rejects departments that do not accept private consultations and subsidiaries", () => {
    const closed = setup({ privateSetting: { enabled: false } });
    expect(closed.service.start({ departmentId: closed.department.id, runtimeSubsidiaryId: null, requesterUserId: "111", intake }))
      .toEqual({ ok: false, error: "department_not_private" });

    const child = setup({ subsidiary: "glab" });
    expect(child.service.start({ departmentId: child.department.id, runtimeSubsidiaryId: "glab", requesterUserId: "111", intake }))
      .toEqual({ ok: false, error: "head_office_only" });

    const archived = setup();
    archived.departments.setArchived(archived.department.id, true);
    expect(archived.service.start({ departmentId: archived.department.id, runtimeSubsidiaryId: null, requesterUserId: "111", intake }))
      .toEqual({ ok: false, error: "department_archived" });
  });

  it("requires the required intake items", () => {
    const { service, department } = setup();
    expect(service.start({
      departmentId: department.id, runtimeSubsidiaryId: null, requesterUserId: "111", intake: { ...intake, role_title: " " },
    })).toEqual({ ok: false, error: "intake_incomplete" });
  });
});

describe("PrivateConsultationService approval and members", () => {
  function pending() {
    const ctx = setup();
    const started = ctx.service.start({ departmentId: ctx.department.id, runtimeSubsidiaryId: null, requesterUserId: "111", intake });
    if (!started.ok) throw new Error(started.error);
    return { ...ctx, id: started.consultation.id };
  }

  it("lets a viewer with launch rights approve once", () => {
    const { service, id } = pending();
    expect(service.approve(id, "111")).toEqual({ ok: false, error: "not_allowed" });
    expect(service.approve(id, "555")).toEqual({ ok: false, error: "not_allowed" });
    const approved = service.approve(id, "900");
    expect(approved.ok && approved.consultation.approved_by).toBe("900");
    expect(service.approve(id, "901")).toEqual({ ok: false, error: "not_pending_approval" });
  });

  it("lets only the requester and approvers invite or remove, and never removes the requester (CC-CONSULT-INV-02)", () => {
    const { service, store, id } = pending();
    expect(service.invite(id, "111", "333")).toMatchObject({ ok: true, member: { reason: "invited", added_by: "111" } });
    expect(service.invite(id, "333", "444")).toEqual({ ok: false, error: "not_allowed" });
    expect(service.remove(id, "900", "111")).toEqual({ ok: false, error: "cannot_remove_requester" });
    expect(service.remove(id, "900", "333")).toEqual({ ok: true, removed: true });
    expect(store.members(id).map((m) => m.platform_user_id)).toEqual(["111", "900", "901"]);
  });

  it("reports the current membership of a user", () => {
    const { service, id } = pending();
    expect(service.memberOf(id, "900")?.reason).toBe("approver");
    expect(service.memberOf(id, "555")).toBeNull();
  });

  it("closes idempotently and refuses member changes afterwards", () => {
    const { service, id } = pending();
    expect(service.close(id)).toBe(true);
    expect(service.close(id)).toBe(false);
    expect(service.invite(id, "111", "333")).toEqual({ ok: false, error: "consultation_closed" });
  });
});
