import { z } from "zod";
import type { Database } from "better-sqlite3";
import { makeDiscordConfigRepo, type DiscordConfigRepo } from "../db/discord-repo.js";
import { emptySelection, type StatusSelection } from "./policy.js";

export const SelectionSchema = z.object({
  sites: z.array(z.string().min(1).max(120)).max(200),
  services: z.array(z.string().min(1).max(1_500)).max(1000),
}).strict();
const KEY = "service_status_selection";
/** @implements CC-SS-02 — saved in the existing subsidiary-scoped config store. */
export function statusSettings(db: Database, subsidiaryId: string) {
  const config = makeDiscordConfigRepo(db, `sub:${subsidiaryId}`);
  return selectionStore(config);
}
export function headquartersStatusSettings(config: Pick<DiscordConfigRepo, "get" | "set">, subsidiaryId: string) {
  const prefix = `sub:${subsidiaryId}::`;
  return selectionStore({ get: (key) => config.get(prefix + key), set: (key, value) => config.set(prefix + key, value) });
}
function selectionStore(config: Pick<DiscordConfigRepo, "get" | "set">) {
  return {
    get(): StatusSelection {
      try { return SelectionSchema.parse(JSON.parse(config.get(KEY) ?? "null")); }
      catch { return emptySelection(); /* malformed/unset means no visibility */ }
    },
    set(value: StatusSelection): void {
      const parsed = SelectionSchema.parse(value);
      config.set(KEY, JSON.stringify({ sites: [...new Set(parsed.sites)].sort(), services: [...new Set(parsed.services)].sort() }));
    },
  };
}
