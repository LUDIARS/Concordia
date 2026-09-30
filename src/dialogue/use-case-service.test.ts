import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UseCasesRepo } from "../db/use-cases-repo.js";
import { USE_CASE_FORMATS } from "./formats.js";
import { UseCaseService } from "./use-case-service.js";

function makeService() {
  const db = makeTestDb();
  const repo = new UseCasesRepo(db);
  return { db, repo, service: new UseCaseService({ repo, now: () => 5 }) };
}

describe("UseCaseService", () => {
  it("creates a use case from a format's initial values", () => {
    const { service } = makeService();
    const result = service.create({ name: "技術相談", slug: "tech-qa", format: "qa" });
    expect(result).toMatchObject({
      ok: true,
      useCase: {
        format: "qa",
        work_mode: "read-only",
        use_requester_profile: 1,
        summary: USE_CASE_FORMATS.qa.summary,
        pre_data: USE_CASE_FORMATS.qa.preData,
        created_at: 5,
      },
    });
  });

  it("lets explicit values override the format", () => {
    const { service } = makeService();
    const result = service.create({ name: "総務", slug: "general", format: "chores", work_mode: "read-only", pre_data: "" });
    expect(result).toMatchObject({ ok: true, useCase: { work_mode: "read-only", pre_data: "" } });
  });

  it("rejects a duplicate slug on create and update", () => {
    const { service } = makeService();
    service.create({ name: "a", slug: "a", format: "qa" });
    const b = service.create({ name: "b", slug: "b", format: "qa" });
    expect(service.create({ name: "a2", slug: "a", format: "qa" })).toEqual({ ok: false, error: "use_case_slug_taken" });
    if (!b.ok) throw new Error("setup failed");
    expect(service.update(b.useCase.id, { slug: "a" })).toEqual({ ok: false, error: "use_case_slug_taken" });
  });

  it("refuses to delete a use case referenced by a department (CC-DLG-INV-06)", () => {
    const { db, service } = makeService();
    const created = service.create({ name: "技術相談", slug: "tech-qa", format: "qa" });
    if (!created.ok) throw new Error("setup failed");
    db.prepare(`INSERT INTO departments(id, subsidiary_id, name, slug, use_case_id, created_at, updated_at)
      VALUES ('d1', NULL, '技術相談課', 'qa', ?, 1, 1)`).run(created.useCase.id);
    expect(service.delete(created.useCase.id)).toEqual({ ok: false, error: "use_case_in_use", references: 1 });
    expect(service.setArchived(created.useCase.id, true)).toMatchObject({ ok: true, useCase: { archived_at: 5 } });
  });

  it("deletes an unreferenced use case", () => {
    const { service, repo } = makeService();
    const created = service.create({ name: "x", slug: "x", format: "sparring" });
    if (!created.ok) throw new Error("setup failed");
    expect(service.delete(created.useCase.id)).toEqual({ ok: true });
    expect(repo.find(created.useCase.id)).toBeNull();
    expect(service.delete("missing")).toEqual({ ok: false, error: "use_case_not_found" });
  });
});
