import { z } from 'zod';
import { parseSiteEventPayload, type SiteEventPayload } from '../remote-session-payload.js';

export const WorkloadEvent = z.object({
  type: z.literal('workload-event'), body: z.string().max(64 * 1024),
  headers: z.record(z.string().max(32_800)).refine(h => Object.keys(h).length <= 10),
}).strict();
export function eventPermission(payload: SiteEventPayload): { action: 'ai-spawn' | 'ai-inject'; resource: string } {
  return { action: payload.type === 'spawn' ? 'ai-spawn' : 'ai-inject', resource: `thread:${payload.guild_id}:${payload.channel_id}` };
}
export function parseEventBody(body: string): SiteEventPayload | null {
  try { return parseSiteEventPayload(JSON.parse(body)); }
  catch { return null; }
}
