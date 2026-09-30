import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConsultationPublicationsRepo } from "./consultation-publications-repo.js";

describe("ConsultationPublicationsRepo", () => {
  it("publishes a proposal once and keeps the Tabula page", () => {
    const repo = new ConsultationPublicationsRepo(makeTestDb());
    const row = repo.create({ consultation_id: "pc_1", title: "集約の切り方", summary: "不変条件の単位で切る" }, 1);
    expect(row).toMatchObject({ status: "proposed", tabula_url: null });
    repo.recordError(row.id, "tabula_unreachable", 2);
    expect(repo.find(row.id)?.last_error).toBe("tabula_unreachable");

    const published = { decided_by: "111", published_text: "直した要約", tabula_page_id: "page-1", tabula_url: "https://tabula/#page=page-1" };
    expect(repo.markPublished(row.id, published, 3)).toBe(true);
    expect(repo.markPublished(row.id, published, 4)).toBe(false);
    expect(repo.find(row.id)).toMatchObject({ status: "published", decided_by: "111", last_error: null, published_text: "直した要約" });
  });

  it("closes a proposal as declined or withdrawn only while proposed", () => {
    const repo = new ConsultationPublicationsRepo(makeTestDb());
    const declined = repo.create({ consultation_id: "pc_1", title: "a", summary: "b" }, 1);
    expect(repo.markClosed(declined.id, "declined", "111", 2)).toBe(true);
    expect(repo.markClosed(declined.id, "withdrawn", "900", 3)).toBe(false);
    const withdrawn = repo.create({ consultation_id: "pc_1", title: "c", summary: "d" }, 4);
    expect(repo.markClosed(withdrawn.id, "withdrawn", "900", 5)).toBe(true);
    expect(repo.listForConsultation("pc_1").map((p) => p.status)).toEqual(["withdrawn", "declined"]);
  });
});
