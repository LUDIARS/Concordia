import { describe, expect, it } from "vitest";
import { buildTeamFanoutTargets } from "./cron-fanout.js";

describe("buildTeamFanoutTargets", () => {
  it("チームごとに 1 対象を作り、 args と options にチームを載せる", () => {
    const targets = buildTeamFanoutTargets([
      { id: "team_1", slug: "glab", name: "GLab" },
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0].key).toBe("glab");
    expect(targets[0].args).toEqual({
      team_id: "team_1",
      team_slug: "glab",
      team_name: "GLab",
    });
    // delegation run をチームに帰属させるのは options.team (args ではない)。
    expect(targets[0].options).toEqual({ team: "team_1" });
  });

  it("起動順を安定させるため slug 昇順に整列する", () => {
    const targets = buildTeamFanoutTargets([
      { id: "team_z", slug: "zeta", name: "Zeta" },
      { id: "team_a", slug: "alpha", name: "Alpha" },
      { id: "team_m", slug: "mid", name: "Mid" },
    ]);

    expect(targets.map((t) => t.key)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("slug が空なら id を key に使う", () => {
    const targets = buildTeamFanoutTargets([
      { id: "team_noslug", slug: "", name: "No Slug" },
    ]);

    expect(targets[0].key).toBe("team_noslug");
  });

  it("チームが 0 件なら対象も 0 件", () => {
    expect(buildTeamFanoutTargets([])).toEqual([]);
  });

  it("入力配列を破壊しない", () => {
    const teams = [
      { id: "team_z", slug: "zeta", name: "Zeta" },
      { id: "team_a", slug: "alpha", name: "Alpha" },
    ];
    buildTeamFanoutTargets(teams);
    expect(teams.map((t) => t.slug)).toEqual(["zeta", "alpha"]);
  });
});
