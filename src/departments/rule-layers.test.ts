import { describe, expect, it } from "vitest";
import { departmentRulesTextEntry, layerSessionRules, type ScopedRule } from "./rule-layers.js";

function rule(title: string, scope: { team_id?: string; department_id?: string } = {}): ScopedRule {
  return { kind: "block", title, description: title, team_id: scope.team_id ?? null, department_id: scope.department_id ?? null };
}

const rules: ScopedRule[] = [
  rule("team-a", { team_id: "team-a" }),
  rule("global-1"),
  rule("dept-dev", { department_id: "dept-dev" }),
  rule("dept-ops", { department_id: "dept-ops" }),
  rule("team-b", { team_id: "team-b" }),
  rule("global-2"),
];

describe("layerSessionRules", () => {
  it("orders global, department text, department rules, then team rules", () => {
    const layered = layerSessionRules(
      rules,
      { teamId: "team-a", departmentId: "dept-dev" },
      { id: "dept-dev", name: "開発部", rules_text: "main へ直接 push しない" },
    );
    expect(layered.map((entry) => entry.title)).toEqual([
      "global-1", "global-2", "部署ルール: 開発部", "dept-dev", "team-a",
    ]);
  });

  it("never mixes another department's or team's rules", () => {
    const layered = layerSessionRules(rules, { teamId: null, departmentId: "dept-ops" }, null);
    expect(layered.map((entry) => entry.title)).toEqual(["global-1", "global-2", "dept-ops"]);
  });

  it("keeps the pre-department behavior for unassigned sessions (CC-DEPT-INV-08)", () => {
    const layered = layerSessionRules(rules, { teamId: "team-b", departmentId: null }, null);
    expect(layered.map((entry) => entry.title)).toEqual(["global-1", "global-2", "team-b"]);
  });

  it("ignores a department source that does not match the session scope", () => {
    const layered = layerSessionRules([], { teamId: null, departmentId: "dept-ops" }, {
      id: "dept-dev", name: "開発部", rules_text: "x",
    });
    expect(layered).toEqual([]);
  });

  it("strips scope columns from the supplied entries", () => {
    const [entry] = layerSessionRules([rule("global-1")], { teamId: null, departmentId: null }, null);
    expect(entry).toEqual({ kind: "block", title: "global-1", description: "global-1" });
  });
});

describe("departmentRulesTextEntry", () => {
  it("adds nothing for blank rules", () => {
    expect(departmentRulesTextEntry({ id: "d", name: "n", rules_text: "  \n" })).toEqual([]);
  });
});
