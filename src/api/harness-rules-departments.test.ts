import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessRulesRepo } from "../db/harness-rules-repo.js";
import { harnessRulesRouter } from "./harness-rules.js";

// 部署に絞ったハーネスルール (spec/feature/departments.md §6 / §7)。
describe("harnessRulesRouter department scope", () => {
  function makeApp() {
    const repo = new HarnessRulesRepo(makeTestDb());
    return { repo, app: new Hono().route("/v1/harness-rules", harnessRulesRouter({ repo })) };
  }
  const post = (body: unknown): RequestInit => ({
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("creates department-scoped rules and rejects rows scoped to both a team and a department", async () => {
    const { app } = makeApp();
    const created = await app.request("/v1/harness-rules", post({ kind: "block", description: "PR は Revisor 経由", department_id: "dept-dev" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ rule: { department_id: "dept-dev", team_id: null } });
    const both = await app.request("/v1/harness-rules", post({ kind: "block", description: "x", department_id: "dept-dev", team_id: "team-a" }));
    expect(both.status).toBe(400);
  });

  it("hides department rows by default and adds them by department or scope=all", async () => {
    const { app, repo } = makeApp();
    repo.create({ kind: "block", title: "global", description: "g", sort_order: 0 });
    repo.create({ kind: "block", title: "dev", description: "d", department_id: "dept-dev", sort_order: 1 });
    repo.create({ kind: "block", title: "ops", description: "o", department_id: "dept-ops", sort_order: 2 });
    const titles = async (query: string) =>
      ((await (await app.request(`/v1/harness-rules${query}`)).json()) as { rules: Array<{ title: string }> }).rules.map((r) => r.title);

    expect(await titles("?all=1")).toEqual(["global"]);
    expect(await titles("?department_id=dept-dev")).toEqual(["global", "dev"]);
    expect(await titles("?scope=all")).toEqual(["global", "dev", "ops"]);
  });
});
