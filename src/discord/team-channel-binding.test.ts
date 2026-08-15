import { describe, expect, it } from "vitest";
import { resolveTeamFromChannel, type TeamChannelLookup } from "./team-channel-binding.js";

function lookup(rows: {
  surfaces?: Record<string, { id: string; name: string }>;
  categories?: Record<string, { id: string; name: string }>;
}): TeamChannelLookup {
  return {
    findBySurfaceChannelId: (id) => rows.surfaces?.[id] ?? null,
    findByDiscordCategoryId: (id) => rows.categories?.[id] ?? null,
  };
}

describe("resolveTeamFromChannel", () => {
  it("binds a team when the command runs on one of its surfaces", () => {
    const source = lookup({ surfaces: { "surface-1": { id: "team_a", name: "GLab" } } });
    expect(resolveTeamFromChannel(source, { channelId: "surface-1", parentId: null, categoryId: null }))
      .toEqual({ teamId: "team_a", teamName: "GLab", via: "surface" });
  });

  it("binds through the parent when spawned inside a forum thread", () => {
    const source = lookup({ surfaces: { forum: { id: "team_a", name: "GLab" } } });
    expect(resolveTeamFromChannel(source, { channelId: "thread-9", parentId: "forum", categoryId: "cat" }))
      .toEqual({ teamId: "team_a", teamName: "GLab", via: "thread-parent-surface" });
  });

  it("falls back to the owning category", () => {
    const source = lookup({ categories: { cat: { id: "team_a", name: "GLab" } } });
    expect(resolveTeamFromChannel(source, { channelId: "random", parentId: null, categoryId: "cat" }))
      .toEqual({ teamId: "team_a", teamName: "GLab", via: "category" });
  });

  it("prefers the nearest surface over the category", () => {
    const source = lookup({
      surfaces: { "surface-1": { id: "team_near", name: "Near" } },
      categories: { cat: { id: "team_far", name: "Far" } },
    });
    expect(resolveTeamFromChannel(source, { channelId: "surface-1", parentId: null, categoryId: "cat" })?.teamId)
      .toBe("team_near");
  });

  it("returns null outside every team surface so the session stays unassigned", () => {
    const source = lookup({});
    expect(resolveTeamFromChannel(source, { channelId: "c", parentId: "p", categoryId: "cat" })).toBeNull();
    expect(resolveTeamFromChannel(source, { channelId: null, parentId: null, categoryId: null })).toBeNull();
  });
});
