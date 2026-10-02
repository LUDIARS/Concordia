import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { departmentsRouter } from "../api/departments.js";
import { useCasesRouter } from "../api/use-cases.js";
import { DepartmentsRepo } from "../db/departments-repo.js";
import { RequesterProfilesRepo } from "../db/requester-profiles-repo.js";
import { UseCaseCorrectionsRepo } from "../db/use-case-corrections-repo.js";
import { UseCasesRepo } from "../db/use-cases-repo.js";
import { DepartmentService } from "../departments/service.js";
import { buildLaunchContext } from "./launch-context.js";
import { PLANNING_ADJUSTMENT_FORMAT } from "./planning-adjustment.js";
import { UseCaseService } from "./use-case-service.js";

function setup() {
  const db = makeTestDb();
  const useCases = new UseCasesRepo(db);
  const corrections = new UseCaseCorrectionsRepo(db);
  const departments = new DepartmentsRepo(db);
  const profiles = new RequesterProfilesRepo(db);
  const service = new UseCaseService({ repo: useCases });
  const app = new Hono()
    .route("/v1/use-cases", useCasesRouter({ repo: useCases, service, corrections }))
    .route("/v1/departments", departmentsRouter({
      repo: departments,
      service: new DepartmentService({
        repo: departments,
        organizations: { exists: () => false, projects: () => [] },
        useCases: { isAssignable: (id) => useCases.find(id)?.archived_at === null },
      }),
      isKnownProvider: (provider) => provider === "codex",
      isActiveTemplate: () => false,
    }));
  return { app, useCases, corrections, departments, profiles, service };
}

function request(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("企画調整課 (CC-PLAN-01〜04)", () => {
  it("creates an editable planning department and supplies scoped context without technical intake", async () => {
    const { app, useCases, corrections, departments, profiles } = setup();
    const response = await app.request("/v1/use-cases", request("POST", {
      name: "企画調整", slug: "planning-adjustment", format: "planning-adjustment",
    }));
    expect(response.status).toBe(201);
    const { use_case } = await response.json() as { use_case: { id: string } };
    expect(useCases.find(use_case.id)).toMatchObject({
      work_mode: "edit", intake_enabled: 0, use_requester_profile: 1,
    });
    const created = await app.request("/v1/departments", request("POST", {
      name: "企画調整課", slug: "planning-adjustment", use_case_id: use_case.id,
      settings: {
        launch: { provider: "codex", project: "Ludellus" }, startup_inject: "full",
        output: { thinking: "off", inject_transcript: "off", intermediate: "on", status_card: "on" },
      },
    }));
    expect(created.status).toBe(201);
    const { department } = await created.json() as { department: { id: string; settings: unknown } };
    expect(department.settings).toMatchObject({ startup_inject: "full", output: { intermediate: "on" } });
    expect(departments.findDefault(null)).toBeNull();
    const row = departments.find(department.id);
    if (!row) throw new Error("created department missing");
    profiles.upsert({ subsidiary_id: null, platform: "discord", platform_user_id: "planner" }, {
      skill_level: "非エンジニア", activities: "Ludellus のプランナー",
    });
    for (const [company, text] of [[null, "回復は休憩と呼ぶ"], ["other", "別会社の非公開仕様"]] as const) {
      corrections.create({ use_case_id: use_case.id, subsidiary_id: company, department_id: null,
        session_id: null, source: "webui", question: "", correction: text, author: "owner" });
    }
    const context = buildLaunchContext({
      useCase: (id) => useCases.find(id),
      corrections: (id, company, limit) => corrections.listForLaunch(id, company, limit),
      ensureRequester: (identity, name) => profiles.ensure(identity, name),
    }, { department: row, requester: { platform: "discord", userId: "planner", displayName: "プランナー" } });
    expect(context.readOnly).toBe(false);
    expect(context.block).toContain("企画調整課 / ユースケース: 企画調整 (企画調整)");
    expect(context.block).toContain(PLANNING_ADJUSTMENT_FORMAT.preData);
    expect(context.block).toContain("Ludellus のプランナー");
    expect(context.block).toContain("回復は休憩と呼ぶ");
    expect(context.block).not.toContain("別会社の非公開仕様");
    expect(context.block).not.toContain("### 今回の相談");
  });

  it("keeps edited pre-data when adopting the dedicated format after a chores-based rollout", async () => {
    const { app, useCases } = setup();
    const format = PLANNING_ADJUSTMENT_FORMAT;
    const created = await app.request("/v1/use-cases", request("POST", {
      name: "企画調整", slug: "planning-adjustment", format: "chores",
      summary: format.summary, work_mode: format.workMode, pre_data: format.preData,
      use_requester_profile: format.useRequesterProfile, intake_enabled: format.intake,
    }));
    expect(created.status).toBe(201);
    const { use_case } = await created.json() as { use_case: { id: string } };
    const edited = format.preData + "\n- 待ち時間は短くする。";
    await app.request(`/v1/use-cases/${use_case.id}`, request("PATCH", { pre_data: edited }));
    const updated = await app.request(`/v1/use-cases/${use_case.id}`, request("PATCH", { format: "planning-adjustment" }));
    expect(updated.status).toBe(200);
    expect(useCases.find(use_case.id)).toMatchObject({
      format: "planning-adjustment", pre_data: edited, work_mode: "edit", intake_enabled: 0, use_requester_profile: 1,
    });
  });

  it("allows CDGD to reuse the conversation in a read-only use case without changing the default format", () => {
    const { service } = setup();
    const result = service.create({ name: "CDGD 企画相談", slug: "cdgd-planning",
      format: "planning-adjustment", work_mode: "read-only" });
    expect(result).toMatchObject({ ok: true, useCase: { work_mode: "read-only", intake_enabled: 0 } });
    const next = service.create({ name: "企画調整", slug: "planning", format: "planning-adjustment" });
    expect(next).toMatchObject({ ok: true, useCase: { work_mode: "edit", intake_enabled: 0 } });
  });
});
