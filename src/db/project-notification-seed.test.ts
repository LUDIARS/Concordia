import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseNotificationPolicy } from "../deploy/notification-target-policy.js";
import { applyMigrations } from "./schema.js";
import { applyProjectNotificationSeeds } from "./project-notification-seed.js";
import { ProjectCodesRepo } from "./project-codes-repo.js";

function registryWith(rows: ReadonlyArray<{ code: string; project: string }>) {
  const db = new Database(":memory:");
  applyMigrations(db);
  const repo = new ProjectCodesRepo(db);
  for (const row of rows) {
    repo.register({ code: row.code, project: row.project, repoPath: `E:/repos/${row.project}`, repoOrigin: null, addedBy: "test" });
  }
  const policy = (code: string, column: "deploy_notification" | "release_notification") =>
    parseNotificationPolicy(repo.findByCode(code)?.[column]);
  return { db, repo, policy };
}

const OFF = { enabled: false, hq: false, subsidiaryScope: "none", subsidiaryIds: [] };
const HQ_ONLY = { enabled: true, hq: true, subsidiaryScope: "none", subsidiaryIds: [] };
const HQ_AND_OPERATING = { enabled: true, hq: true, subsidiaryScope: "operating", subsidiaryIds: [] };
const HQ_AND_ALL = { enabled: true, hq: true, subsidiaryScope: "all", subsidiaryIds: [] };

describe("project notification initial values", () => {
  it("applies the specified release and deploy values to the matching registrations", () => {
    const { db, policy } = registryWith([
      { code: "Ex", project: "Excubitor" },
      { code: "Cc", project: "Concordia" },
      { code: "Pf", project: "Praeforma" },
      { code: "El", project: "Elegantia" },
      { code: "Rv", project: "Revisor" },
      { code: "Di", project: "Discutere" },
    ]);
    applyProjectNotificationSeeds(db);
    expect([policy("Ex", "release_notification"), policy("Ex", "deploy_notification")]).toEqual([HQ_ONLY, OFF]);
    expect([policy("Cc", "release_notification"), policy("Cc", "deploy_notification")]).toEqual([HQ_ONLY, HQ_AND_OPERATING]);
    expect([policy("Pf", "release_notification"), policy("Pf", "deploy_notification")]).toEqual([HQ_AND_OPERATING, OFF]);
    expect([policy("El", "release_notification"), policy("El", "deploy_notification")]).toEqual([HQ_AND_ALL, HQ_AND_ALL]);
    expect([policy("Rv", "release_notification"), policy("Rv", "deploy_notification")]).toEqual([HQ_AND_ALL, HQ_AND_OPERATING]);
    expect([policy("Di", "release_notification"), policy("Di", "deploy_notification")]).toEqual([HQ_AND_ALL, OFF]);
    db.close();
  });

  it("does not apply a value to a code registered for another project", () => {
    const { db, policy } = registryWith([{ code: "Ex", project: "Exodus" }]);
    applyProjectNotificationSeeds(db);
    expect([policy("Ex", "release_notification"), policy("Ex", "deploy_notification")]).toEqual([null, null]);
    db.close();
  });

  it("keeps a value saved from the admin UI and leaves unlisted projects on the current rules", () => {
    const { db, repo, policy } = registryWith([{ code: "Cc", project: "Concordia" }, { code: "KS", project: "KuzuSurvivors" }]);
    const saved = JSON.stringify({ enabled: false, hq: false, subsidiary_scope: "none", subsidiary_ids: [] });
    repo.update("Cc", { deployNotification: saved });
    applyProjectNotificationSeeds(db);
    applyProjectNotificationSeeds(db);
    expect(repo.findByCode("Cc")?.deploy_notification).toBe(saved);
    expect(policy("Cc", "release_notification")).toEqual(HQ_ONLY);
    expect([policy("KS", "release_notification"), policy("KS", "deploy_notification")]).toEqual([null, null]);
    db.close();
  });
});
