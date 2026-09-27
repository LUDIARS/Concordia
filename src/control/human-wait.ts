/** @implements CC-TASK-LINKED-FOLLOWUP — explicit coordination wait, separate from nudge delivery claims. */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { humanResponseSession } from "./human-response-confirmation.js";
import { parseRequesterSource } from "./requester.js";

export const HUMAN_WAIT_KEY = "cc_human_wait";

export interface HumanWaitState {
  active: boolean;
  summary: string;
  task_references: string[];
  since: number;
}

export function readHumanWait(metadata: string | null): HumanWaitState | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[HUMAN_WAIT_KEY];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.active !== true || typeof row.summary !== "string"
      || !Array.isArray(row.task_references) || typeof row.since !== "number") return null;
    return { active: true, summary: row.summary,
      task_references: row.task_references.filter((item): item is string => typeof item === "string"), since: row.since };
  } catch { return null; }
}

export function isHumanWaitActive(repo: Pick<SessionsRepo, "findSession">, sessionId: string): boolean {
  return !!readHumanWait(repo.findSession(sessionId)?.metadata ?? null);
}

export function startHumanWait(repo: Pick<SessionsRepo, "findSession" | "updateMetadata">): { stop(): void } {
  const unsubscribe = eventBus.subscribe((event) => {
    const sessionId = humanResponseSession(event);
    const provenHuman = event.type === "question.answered"
      || (event.type === "session.inject" && !!parseRequesterSource(event.source));
    if (!sessionId || !provenHuman || !isHumanWaitActive(repo, sessionId)) return;
    repo.updateMetadata(sessionId, (metadata) => ({ ...metadata, [HUMAN_WAIT_KEY]: null }));
  });
  return { stop: unsubscribe };
}
