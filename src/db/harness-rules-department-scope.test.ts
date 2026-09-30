import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessRulesRepo } from "./harness-rules-repo.js";

function makeRepo(): HarnessRulesRepo {
  const repo = new HarnessRulesRepo(makeTestDb());
  // 同じミリ秒に作った行の順序は不定なので sort_order で固定する。
  repo.create({ kind: "block", title: "global", description: "g", sort_order: 0 });
  repo.create({ kind: "block", title: "dept-dev", description: "d", department_id: "dept-dev", sort_order: 1 });
  repo.create({ kind: "block", title: "dept-ops", description: "o", department_id: "dept-ops", sort_order: 2 });
  repo.create({ kind: "allow", title: "team-a", description: "t", team_id: "team-a", sort_order: 3 });
  return repo;
}

describe("HarnessRulesRepo department scope", () => {
  it("keeps department rows out of the default list read by subsidiary guards", () => {
    expect(makeRepo().list().map((rule) => rule.title)).toEqual(["global", "team-a"]);
  });

  it("adds only the requested department, or every department when asked", () => {
    const repo = makeRepo();
    expect(repo.list({ departmentId: "dept-dev" }).map((rule) => rule.title)).toEqual(["global", "dept-dev", "team-a"]);
    expect(repo.list({ includeAllScopes: true }).map((rule) => rule.title))
      .toEqual(["global", "dept-dev", "dept-ops", "team-a"]);
  });

  it("does not leak department rows into the team-only lookup", () => {
    expect(makeRepo().listForTeam("team-a").map((rule) => rule.title)).toEqual(["global", "team-a"]);
  });

  it("selects global, the session department and the session team for supply", () => {
    const repo = makeRepo();
    expect(repo.listForScope({ teamId: "team-a", departmentId: "dept-ops" }).map((rule) => rule.title))
      .toEqual(["global", "dept-ops", "team-a"]);
    expect(repo.listForScope({ teamId: null, departmentId: null }).map((rule) => rule.title)).toEqual(["global"]);
  });
});
