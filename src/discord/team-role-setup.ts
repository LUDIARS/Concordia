import type { Guild } from "discord.js";
import { z } from "zod";

export const TeamRoleNames = z.array(z.string().trim().min(1).max(100)
  .refine(name => !name.startsWith("@") && !/[\u0000-\u001f]/.test(name)))
  .max(20).refine(names => new Set(names).size === names.length);

const pending = new Map<string, Promise<void>>();

/** Create unassigned labels only in the guild selected by the team runtime. */
export async function ensureTeamRoles(guild: Guild, names: readonly string[]) {
  for (const name of names) {
    const key = JSON.stringify([guild.id, name]);
    const active = pending.get(key);
    if (active) { await active; continue; }
    const ensure = async () => {
      const matches = (await guild.roles.fetch()).filter(role => role.name === name);
      if (matches.size) {
        const role = matches.first()!;
        if (matches.size !== 1 || role.managed || role.permissions.bitfield !== 0n || role.mentionable || role.hoist)
          throw new Error("team role name conflicts with existing role");
        return;
      }
      await guild.roles.create({ name, permissions: [], hoist: false, mentionable: false, reason: "Cc team role setup" });
    };
    const work = ensure();
    pending.set(key, work);
    try { await work; } finally { pending.delete(key); }
  }
}
