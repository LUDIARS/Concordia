/** @implements spec/feature/human-response-confirmation.md */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { parseRequesterSource } from "./requester.js";
import { CONFIRMATION_AT_KEY, CONFIRMATION_BASELINE_KEY } from "./human-response-activity-release.js";

type ConfirmationSessions = Pick<SessionsRepo, "findSession" | "mergeMetadata">;
const KEY = "human_response_confirmation";

/**
 * 親セッションが人間の回答を子へ中継する inject の正規 source。
 * `relay-human:<親 session id>` または `relay-human:<親 session id>:<回答者の表示名>`。
 * 自由形式 (例 "neco (親 … 経由)") は人間の出所として扱わない。
 */
export const RELAY_HUMAN_SOURCE_PREFIX = "relay-human:";

export function parseRelayHumanSource(source: unknown): { parentSessionId: string; label: string | null } | null {
  if (typeof source !== "string" || !source.startsWith(RELAY_HUMAN_SOURCE_PREFIX)) return null;
  const [parentSessionId, ...rest] = source.slice(RELAY_HUMAN_SOURCE_PREFIX.length).split(":");
  if (!parentSessionId || !/^[A-Za-z0-9._-]+$/.test(parentSessionId)) return null;
  const label = rest.join(":").trim();
  return { parentSessionId, label: label || null };
}

/** Only provenance-bearing human input can reopen a confirmation cycle. */
export function humanResponseSession(event: ConcordiaEvent): string | null {
  if (event.type === "question.answered") return event.target_session_id;
  if (event.type === "session.inject"
    && (parseRequesterSource(event.source) || parseRelayHumanSource(event.source) || event.provenance?.actorId?.trim())) {
    return event.target_session_id;
  }
  // Injected prompts also appear as user transcript frames. Neither their echo nor an
  // assistant acknowledgement proves that the person has responded.
  return null;
}

function isWaiting(metadata: string | null): boolean {
  if (!metadata) return false;
  // Callers include the stalled-session sweep, which walks every active session in one
  // pass. A single unparseable metadata blob must not abort the sweep for the rest.
  let value: unknown;
  try {
    value = JSON.parse(metadata);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[KEY] === true;
}

export function isWaitingForHumanResponse(repo: ConfirmationSessions, sessionId: string): boolean {
  const session = repo.findSession(sessionId);
  return session ? isWaiting(session.metadata) : false;
}

/** Claim synchronously before emitting or awaiting: reentrant replies cannot send twice. */
export function claimHumanResponseConfirmation(repo: ConfirmationSessions, sessionId: string): boolean {
  const session = repo.findSession(sessionId);
  if (!session || session.status !== "active" || isWaiting(session.metadata)) return false;
  // 確認の時刻を残し、前の周期の基準は捨てる (観測された動きでの解除は human-response-activity-release.ts)。
  repo.mergeMetadata(sessionId, { [KEY]: true, [CONFIRMATION_AT_KEY]: Math.floor(Date.now() / 1000), [CONFIRMATION_BASELINE_KEY]: null });
  repo.mergeMetadata(sessionId,{ human_response_confirmation_source:"explicit_human_confirmation" });
  return true;
}

export function startHumanResponseConfirmation(repo: ConfirmationSessions): { stop(): void } {
  const unsubscribe = eventBus.subscribe((event) => {
    const sessionId = humanResponseSession(event);
    if (!sessionId) return;
    const session = repo.findSession(sessionId);
    if (!session || !isWaiting(session.metadata)) return;
    repo.mergeMetadata(sessionId, { [KEY]: false });
  });
  return { stop: unsubscribe };
}
/** Recover only attributed nudge latches. Ambiguous legacy booleans can also be
 * genuine runtime/checkResidual questions and must survive until human input. */
export function recoverLegacyNudgeConfirmations(repo: Pick<SessionsRepo,"findAllActive" | "updateMetadata">): void {
  for (const session of repo.findAllActive()) repo.updateMetadata(session.id,(metadata) => {
    if (metadata[KEY] !== true || metadata.human_response_confirmation_source !== "auto:stall-nudge") return metadata;
    return { ...metadata,[KEY]:false,legacy_nudge_confirmation_recovered:true };
  });
}
