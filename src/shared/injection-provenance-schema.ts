import { z } from "zod";
import type { InjectionProvenance } from "./injection-provenance.js";

/** HTTP / WebSocket 境界で provenance を検証し、巨大・任意形状の metadata 化を防ぐ。 */
export const InjectionProvenanceSchema: z.ZodType<InjectionProvenance> = z.object({
  kind: z.literal("reaction-workflow"),
  action: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  platform: z.enum(["discord", "slack"]),
  emoji: z.string().min(1).max(64).optional(),
  sourceMessageId: z.string().min(1).max(256).optional(),
  actorId: z.string().min(1).max(128).optional(),
}).strict();
