// @implements CC-ACTIO-CHAT-01
import { z } from "zod";
const destinations = z.array(z.object({
  teamId: z.string().min(1).max(200), subsidiaryId: z.string().min(1).max(200),
  workspaceId: z.string().regex(/^\d{5,25}$/),
}).strict()).max(200);
export type ChatDestination = z.infer<typeof destinations>[number];

export function readChatDestinations(env: Readonly<Record<string, string | undefined>>): ChatDestination[] {
  try {
    let value: unknown = [];
    if (env.CONCORDIA_ACTIO_CHAT_DESTINATIONS !== undefined) value = JSON.parse(env.CONCORDIA_ACTIO_CHAT_DESTINATIONS);
    else if (env.EXCUBITOR_SERVICE_CONFIG_JSON) {
      const config = z.object({ actioChatDestinations: z.unknown().optional() }).parse(JSON.parse(env.EXCUBITOR_SERVICE_CONFIG_JSON));
      value = config.actioChatDestinations ?? [];
    }
    const rows = destinations.parse(value);
    if (new Set(rows.map(r => r.teamId)).size !== rows.length) throw new Error();
    return rows;
  } catch { throw new Error("Invalid Actio chat destination configuration"); }
}

/** Only an administrator's explicit binding permits use of another Discord connection. */
export function destinationMatches(binding: ChatDestination, input: { platform: string; workspaceId: string },
  target: { enabled: number | boolean; platform: string; mode: string; guild_id: string | null } | null): boolean {
  return !!target?.enabled && target.mode === "subsidiary" && target.platform === "discord"
    && input.platform === "discord" && input.workspaceId === binding.workspaceId && target.guild_id === binding.workspaceId;
}
