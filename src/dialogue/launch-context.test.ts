import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConsultationIntakesRepo } from "../db/consultation-intakes-repo.js";
import { RequesterProfilesRepo } from "../db/requester-profiles-repo.js";
import { UseCaseCorrectionsRepo } from "../db/use-case-corrections-repo.js";
import { UseCasesRepo } from "../db/use-cases-repo.js";
import { buildLaunchContext, type LaunchContextPorts } from "./launch-context.js";
import { UseCaseService } from "./use-case-service.js";

function setup() {
  const db = makeTestDb();
  const useCases = new UseCasesRepo(db);
  const corrections = new UseCaseCorrectionsRepo(db);
  const profiles = new RequesterProfilesRepo(db);
  const intakes = new ConsultationIntakesRepo(db);
  const service = new UseCaseService({ repo: useCases });
  const created = service.create({ name: "技術相談", slug: "tech-qa", format: "qa" });
  if (!created.ok) throw new Error("setup failed");
  const ports: LaunchContextPorts = {
    useCase: (id) => useCases.find(id),
    corrections: (useCaseId, subsidiaryId, limit) => corrections.listForLaunch(useCaseId, subsidiaryId, limit),
    ensureRequester: (identity, displayName) => profiles.ensure(identity, displayName),
    saveRequesterDefaults: (identity, fields) => { profiles.upsert(identity, fields); },
    recordIntake: (input) => { intakes.record(input); },
  };
  return { useCase: created.useCase, useCases, corrections, profiles, intakes, ports };
}

function correction(useCaseId: string, subsidiaryId: string | null, text: string) {
  return { use_case_id: useCaseId, subsidiary_id: subsidiaryId, department_id: null, session_id: null,
    source: "webui" as const, question: "", correction: text, author: "" };
}

describe("buildLaunchContext", () => {
  it("returns no block for a department without a use case, but still lists the requester", () => {
    const { ports, profiles } = setup();
    const context = buildLaunchContext(ports, {
      department: { name: "総務", subsidiary_id: null, use_case_id: null },
      requester: { platform: "discord", userId: "111", displayName: "neco" },
    });
    expect(context).toEqual({ block: null, readOnly: false });
    expect(profiles.list(null)).toMatchObject([{ platform_user_id: "111", display_name: "neco" }]);
  });

  it("passes only the same company's active corrections (CC-DLG-INV-01)", () => {
    const { ports, useCase, corrections } = setup();
    corrections.create(correction(useCase.id, null, "本社の訂正"), 1);
    corrections.create(correction(useCase.id, "glab", "glab の訂正"), 2);
    const inactive = corrections.create(correction(useCase.id, null, "無効化した訂正"), 3);
    corrections.patch(inactive.id, { active: false });

    const context = buildLaunchContext(ports, {
      department: { name: "技術相談課", subsidiary_id: null, use_case_id: useCase.id },
      requester: null,
    });
    expect(context.readOnly).toBe(true);
    expect(context.block).toContain("本社の訂正");
    expect(context.block).not.toContain("glab の訂正");
    expect(context.block).not.toContain("無効化した訂正");
  });

  it("includes the requester notes when the use case asks for them", () => {
    const { ports, useCase, profiles } = setup();
    profiles.upsert({ subsidiary_id: null, platform: "discord", platform_user_id: "111" }, { skill_level: "初級", activities: "Unity" });
    const context = buildLaunchContext(ports, {
      department: { name: "技術相談課", subsidiary_id: null, use_case_id: useCase.id },
      requester: { platform: "discord", userId: "111", displayName: "neco" },
    });
    expect(context.block).toContain("- 技術者レベル: 初級");
    expect(context.block).toContain("- 名前: neco");
  });

  it("ignores an archived use case", () => {
    const { ports, useCase, useCases } = setup();
    useCases.setArchived(useCase.id, true);
    expect(buildLaunchContext(ports, {
      department: { name: "技術相談課", subsidiary_id: null, use_case_id: useCase.id },
      requester: null,
    })).toEqual({ block: null, readOnly: false });
  });

  it("puts a complete intake into the block, saves the defaults and records it", () => {
    const { ports, useCase, profiles, intakes } = setup();
    const context = buildLaunchContext(ports, {
      department: { id: "dept_qa", name: "技術相談課", subsidiary_id: null, use_case_id: useCase.id },
      requester: { platform: "discord", userId: "111", displayName: "neco" },
      intake: {
        values: { topic: "DDD って何が良いの", skill_level: "初級", role_title: "デザイナー", purpose: "" },
        source: "forum",
        channelId: "thread-1",
      },
    });
    expect(context.block).toContain("### 今回の相談");
    expect(context.block).toContain("- 役職: デザイナー");
    expect(profiles.find({ subsidiary_id: null, platform: "discord", platform_user_id: "111" }))
      .toMatchObject({ skill_level: "初級", role_title: "デザイナー" });
    expect(intakes.latestForChannel("thread-1")).toMatchObject({
      department_id: "dept_qa", use_case_id: useCase.id, source: "forum", topic: "DDD って何が良いの",
    });
  });

  it("ignores the intake when the use case does not use it or it is incomplete", () => {
    const { ports, useCase, useCases, intakes } = setup();
    const intake = {
      values: { topic: "t", skill_level: "", role_title: "エンジニア", purpose: "" },
      source: "forum" as const,
      channelId: "thread-2",
    };
    const incomplete = buildLaunchContext(ports, {
      department: { id: "dept_qa", name: "技術相談課", subsidiary_id: null, use_case_id: useCase.id },
      requester: { platform: "discord", userId: "111", displayName: "neco" },
      intake,
    });
    expect(incomplete.block).not.toContain("今回の相談");

    useCases.patch(useCase.id, { intake_enabled: false });
    const disabled = buildLaunchContext(ports, {
      department: { id: "dept_qa", name: "技術相談課", subsidiary_id: null, use_case_id: useCase.id },
      requester: { platform: "discord", userId: "111", displayName: "neco" },
      intake: { ...intake, values: { ...intake.values, skill_level: "初級" } },
    });
    expect(disabled.block).not.toContain("今回の相談");
    expect(intakes.latestForChannel("thread-2")).toBeNull();
  });
});
