import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import { expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { retireEmptyTeamChannels } from "./team-retire-empty.js";

it("only removes the bound empty legacy channel in this category", async () => {
  const db = makeTestDb();
  try {
    db.prepare("INSERT INTO teams(id,name,slug,created_at,updated_at) VALUES ('t','T','t',1,1)").run();
    const empty = async () => ({ threads: new Map() });
    const remove = vi.fn();
    const base = { type: ChannelType.GuildText, parentId: "cat", permissionsFor: () => ({has: () => true}),
      threads: {fetchActive: empty, fetchArchived: empty}, delete: remove };
    const fetch = async (name: string) => ({ ...base, name, messages: {fetch: async () => ({size: name === "direction" ? 1 : 0})} });
    const guild = {channels: {fetch}, members: {me: {}}} as unknown as Guild;
    for (const name of ["コスト", "direction"]) db.prepare("INSERT INTO team_surfaces VALUES (?,?,?)").run("t",name,name);
    await retireEmptyTeamChannels(db, guild, "t", "other");
    expect(remove).not.toHaveBeenCalled();
    await retireEmptyTeamChannels(db, guild, "t", "cat");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT surface FROM team_surfaces").pluck().all()).toEqual(["direction"]);
  } finally { db.close(); }
});
