import { z } from "zod";

const id = z.string().min(1).max(200);
export const phase = z.enum(["planning", "implementation", "acceptance", "retrospective", "next_planning"]);
export const action = z.enum(["approve", "reject", "hold", "resume", "resubmit"]);
export const projectionSchema = z.object({
  version: z.literal(1), dialogueKey: z.string().min(1).max(420), teamId: id, sprintId: id,
  sprintName: z.string().trim().min(1).max(200), phase, revision: z.number().int().positive(),
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/), held: z.boolean(), closed: z.boolean(), reason: z.string().max(4000),
  summary: z.string().max(24000), taskIds: z.array(id).max(5000),
  actioPath: z.string().max(1000).refine(p => /^\/tasks\/planning(?:[/?#]|$)/.test(p) && !/[\\\r\n]/.test(p), "approved planning path required"),
}).strict().refine(p => p.dialogueKey === `actio:${p.teamId}:${p.sprintId}`, "dialogue identity mismatch");
export type Projection = z.infer<typeof projectionSchema>;
export type Action = z.infer<typeof action>;
export type DeliveryStatus = "pending" | "delivered" | "failed" | "unknown";
export interface Dialogue {
  id: string; projection: Projection; deliveryStatus: DeliveryStatus; lastError: string | null;
  threadId: string | null; guildId: string | null; threadIntent: boolean;
  cardId: string | null; cardIntent: boolean; deliveredRevision: number;
}
export interface HumanEvent {
  eventId: string; dialogueKey: string; teamId: string; sprintId: string; revision: number;
  sourceFingerprint: string; action: Action; reason: string; taskIds: string[];
  actor: { discordUserId: string; discordGuildId: string }; occurredAt: string;
}
export const acknowledgementSchema = z.object({ outcome: z.enum(["applied", "rejected"]), reason: z.string().trim().min(1).max(4000) }).strict();
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;
export interface EventRecord { event: HumanEvent; acknowledgement: Acknowledgement | null; delivered: boolean; intent: boolean }
export interface PhaseNotice { id: string; dialogueId: string; projection: Projection; delivered: boolean; intent: boolean }
export interface Conversation {
  id: string; dialogueId: string; prompt: string; status: "queued" | "running" | "completed" | "unknown";
  output: string; createdAt: number; startedAt: number | null; delivered: boolean; intent: boolean;
}
export class DialogueConflict extends Error {}
export function canonicalProjection(input: Projection): string {
  const p = projectionSchema.parse(input);
  return JSON.stringify({ ...p, taskIds: [...new Set(p.taskIds)].sort() });
}
export function assertProjectionVersion(current: Projection | null, incoming: Projection): void {
  if (current && (incoming.revision < current.revision || incoming.revision === current.revision
    && canonicalProjection(incoming) !== canonicalProjection(current))) throw new DialogueConflict("提示内容が更新されています。最新の版を確認してください。");
}
export function assertHumanChoice(dialogue: Dialogue, revision: number, channelId: string, guildId: string): void {
  if (dialogue.projection.closed || dialogue.projection.revision !== revision || dialogue.deliveredRevision !== revision || !dialogue.cardId
    || dialogue.threadId !== channelId || dialogue.guildId !== guildId) throw new DialogueConflict("古い確認または別のスレッドです。最新カードから回答してください。");
}
export function dialogueReceipt(dialogue: Dialogue) {
  return { dialogueKey: dialogue.projection.dialogueKey, revision: dialogue.projection.revision,
    deliveryStatus: dialogue.deliveryStatus, lastError: dialogue.lastError,
    threadUrl: dialogue.threadId && dialogue.guildId ? `https://discord.com/channels/${dialogue.guildId}/${dialogue.threadId}` : null };
}
