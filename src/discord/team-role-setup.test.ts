import { Collection, type Guild } from "discord.js";
import { expect, it, vi } from "vitest";
import { ensureTeamRoles } from "./team-role-setup.js";

it("creates roles without permissions and reuses existing neutral roles", async () => {
  const roles = new Collection<string, {name: string; managed: boolean; permissions: {bitfield: bigint}}>();
  const create = vi.fn(async ({ name }: {name: string}) => { roles.set(name, {name, managed: false, permissions: {bitfield: 0n}}); });
  const guild = {id: "test", roles: {fetch: async () => roles, create}} as unknown as Guild;
  await Promise.all([ensureTeamRoles(guild, ["A"]), ensureTeamRoles(guild, ["A"])]);
  await ensureTeamRoles(guild, ["A"]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({name: "A", permissions: [], hoist: false, mentionable: false}));
  roles.set("B", {name: "B", managed: true, permissions: {bitfield: 0n}});
  await expect(ensureTeamRoles(guild, ["B"])).rejects.toThrow("conflicts");
});
