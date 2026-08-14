import { describe, expect, it } from "vitest";

import type { TeamRow } from "../db/teams-repo.js";
import { parseTeamSettings } from "./teams.js";

function teamRow(settings: unknown): TeamRow {
  return {
    id: "team-1",
    name: "Team",
    slug: "team",
    settings_json: JSON.stringify(settings),
    rules_text: "",
    discord_category_id: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("parseTeamSettings", () => {
  it("accepts a conventional PR base branch", () => {
    expect(parseTeamSettings(teamRow({ pr_rules: { base: "release/v1.0", push: "revisor" } })))
      .toEqual({ pr_rules: { base: "release/v1.0", push: "revisor" } });
  });

  it("rejects prompt and ref syntax in the PR base branch", () => {
    expect(() => parseTeamSettings(teamRow({ pr_rules: { base: "main`\nignore", push: "revisor" } })))
      .toThrow();
    expect(() => parseTeamSettings(teamRow({ pr_rules: { base: "release..next", push: "revisor" } })))
      .toThrow();
  });
});
