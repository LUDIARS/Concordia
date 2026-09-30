/**
 * 着手前ルール供給の部署層 (spec/feature/departments.md §6) をルート経由で確かめる。
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "../db/harness-audit-repo.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { harnessSessionRouter } from "./harness-session.js";

function makeApp(scope: { teamId: string | null; departmentId: string | null }) {
  const db = makeTestDb();
  const rules = new HarnessRulesRepo(db);
  const app = new Hono();
  app.route("/v1/harness", harnessSessionRouter({
    audit: new HarnessAuditRepo(db),
    rules,
    sessionContext: () => scope,
    departmentRules: (id) => (id === "dept-dev"
      ? { id, name: "開発部", rules_text: "PR は Revisor 経由で出す" }
      : null),
  }));
  return { app, rules };
}

async function suppliedTitles(app: Hono): Promise<string[]> {
  const response = await app.request("/v1/harness/context", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "実装する", session_id: "s-1" }),
  });
  const body = await response.json() as { rules: Array<{ title: string }> };
  return body.rules.map((rule) => rule.title);
}

describe("/v1/harness/context department layer", () => {
  it("supplies global, department, then team rules without other departments", async () => {
    const { app, rules } = makeApp({ teamId: "team-a", departmentId: "dept-dev" });
    rules.create({ kind: "allow", title: "team-a", description: "t", team_id: "team-a" });
    rules.create({ kind: "block", title: "dept-dev", description: "d", department_id: "dept-dev" });
    rules.create({ kind: "block", title: "dept-ops", description: "o", department_id: "dept-ops" });
    rules.create({ kind: "block", title: "global", description: "g" });

    expect(await suppliedTitles(app)).toEqual(["global", "部署ルール: 開発部", "dept-dev", "team-a"]);
  });

  it("keeps unassigned sessions on global rules only", async () => {
    const { app, rules } = makeApp({ teamId: null, departmentId: null });
    rules.create({ kind: "block", title: "dept-dev", description: "d", department_id: "dept-dev" });
    rules.create({ kind: "block", title: "global", description: "g" });

    expect(await suppliedTitles(app)).toEqual(["global"]);
  });
});
