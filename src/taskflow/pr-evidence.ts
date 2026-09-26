import { z } from "zod";
import { normalizeRepoOrigin } from "../pr/normalize.js";

export const TaskPrEvidence = z.object({
  provider: z.enum(["revisor", "github"]),
  repository: z.string().min(1),
  id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url().nullable(),
  head_sha: z.string().nullable(),
  reviewed_head_sha: z.string().nullable(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  review: z.string(),
  reflection: z.enum(["unknown", "pending", "verified"]),
  observed_at: z.string().datetime(),
});
export type TaskPrEvidence = z.infer<typeof TaskPrEvidence>;

export function mergeTaskPrEvidence(payload: Record<string, unknown> | null,
  evidence: TaskPrEvidence): Record<string, unknown> {
  const incoming = TaskPrEvidence.parse(evidence);
  incoming.repository = normalizeRepoOrigin(incoming.repository).toLowerCase();
  const existing = payload?.pull_requests === undefined ? [] : z.array(TaskPrEvidence).parse(payload.pull_requests);
  const same = (item: TaskPrEvidence): boolean => item.provider === incoming.provider
    && normalizeRepoOrigin(item.repository).toLowerCase() === incoming.repository && item.id === incoming.id;
  const previous = existing.find(same);
  if (previous && Date.parse(previous.observed_at) > Date.parse(incoming.observed_at)) return payload ?? {};
  // A new head invalidates both approval and deployment evidence.
  if (incoming.head_sha !== incoming.reviewed_head_sha || !incoming.head_sha) {
    if (["test_ok", "approved", "success"].includes(incoming.review)) incoming.review = "stale";
  }
  if (previous?.head_sha === incoming.head_sha && previous.reflection === "verified") incoming.reflection = "verified";
  return { ...payload, pull_requests: [...existing.filter((item) => !same(item)), incoming] };
}
