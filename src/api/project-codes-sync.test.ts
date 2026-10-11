/** @implements spec/feature/project-code-registry.md — 改名の追跡 / 大文字小文字の衝突 (CC-PCR-RENAME-01, CC-PCR-CASE-01) */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { projectCodesRouter } from "./project-codes.js";

function setup() {
  const repo = new ProjectCodesRepo(makeTestDb());
  repo.register({ code: "LwP", project: "Ludellus-Praeforma", repoPath: "C:/repos/LP", repoOrigin: null, addedBy: "test" });
  repo.register({ code: "Ld", project: "LUDIARS", repoPath: "C:/repos/LUDIARS", repoOrigin: null, addedBy: "test" });
  return { repo, app: projectCodesRouter({ repo, resolveWorkspaceRoots: () => ["C:/repos"] }) };
}

const patch = (app: ReturnType<typeof setup>["app"], code: string, body: unknown) =>
  app.request(`/${code}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("project code sync surface", () => {
  it("exposes renamed_from on the admin list after a code rename", async () => {
    const { app } = setup();
    expect((await patch(app, "LwP", { code: "LP" })).status).toBe(200);
    const admin = await (await app.request("/admin")).json() as { entries: Array<{ code: string; renamed_from: string[] }> };
    expect(admin.entries.find((entry) => entry.code === "LP")?.renamed_from).toEqual(["LwP"]);
    expect(admin.entries.find((entry) => entry.code === "Ld")?.renamed_from).toEqual([]);
  });

  it("warns, but does not refuse, a code that differs from another only by case", async () => {
    const { app } = setup();
    const response = await patch(app, "LwP", { code: "LD" });
    expect(response.status).toBe(200);
    expect((await response.json()).warnings).toEqual([{ kind: "case_collision", code: "LD", conflicts_with: ["Ld"] }]);
    expect((await (await patch(app, "LD", { domain_review: true })).json()).warnings).toHaveLength(1);
  });
});
