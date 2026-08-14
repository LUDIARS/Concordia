import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus } from "../events.js";
import { openTestingClaim, releaseTestingClaims } from "../testing/claim-lifecycle.js";
import { createChildLogger } from "../shared/logger.js";

/** @implements spec/feature/vibes-mode.md §3 */
const log = createChildLogger("vibes-lifecycle");
const QUESTION_PREFIX = "Vibes testing claim has reached its time limit";

export function startVibesLifecycle(input: {
  sessions: SessionsRepo;
  claims: TestingClaimsRepo;
  questions: DiscordPendingQuestionsRepo;
  claimSec?: number;
  responseSec?: number;
  intervalMs?: number;
  /** team settings の vibes_defaults.claim_sec (teams §3.1)。 未所属・未設定は既定 claimSec。 */
  resolveTeamClaimSec?: (session: { team_id?: string | null; repo_origin: string | null; repo_path: string }) => number | null;
}): { stop(): void } {
  const defaultClaimSec = input.claimSec ?? Number(process.env.CONCORDIA_VIBES_CLAIM_SEC ?? 3600);
  const responseSec = input.responseSec ?? 300;
  const tick = () => {
    const now = Math.floor(Date.now() / 1000);
    for (const claim of input.claims.listUnreleased()) {
      const session = input.sessions.findSession(claim.session_id);
      if (!session || session.status !== "active") continue;
      const claimSec = input.resolveTeamClaimSec?.(session) ?? defaultClaimSec;
      if (now - claim.started_at < claimSec) continue;
      let metadata: Record<string, unknown> = {};
      try { metadata = session.metadata ? JSON.parse(session.metadata) as Record<string, unknown> : {}; } catch { /* legacy metadata */ }
      const requestedAt = typeof metadata.vibes_extension_requested_at === "number" ? metadata.vibes_extension_requested_at : null;
      if (!requestedAt) {
        const question = input.questions.insert({
          session_id: claim.session_id,
          question: `${QUESTION_PREFIX}: ${claim.service}`,
          options: [{ label: "Extend", description: "Renew the claim for one more bounded window." }, { label: "Stop", description: "Release the claim and block this run." }],
        });
        input.sessions.mergeMetadata(claim.session_id, { vibes_extension_requested_at: now, vibes_extension_question_id: question.id });
        eventBus.emit({ type: "question.posted", target_session_id: claim.session_id, question_id: question.id, question: question.question, options: JSON.parse(question.options_json), ts: question.ts });
      } else if (now - requestedAt >= responseSec) {
        releaseTestingClaims(input.claims, { sessionId: claim.session_id, service: claim.service, now });
        input.sessions.setStatus(claim.session_id, "blocked", now);
        input.sessions.appendEvent({ session_id: claim.session_id, ts: now, kind: "vibes-claim-expired", payload: { service: claim.service, reason: "extension-timeout" } });
      }
    }
  };
  const timer = setInterval(() => { try { tick(); } catch (error) { log.warn({ error }, "vibes lifecycle tick failed"); } }, input.intervalMs ?? 30_000);
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.type !== "question.answered") return;
    const question = input.questions.findById(event.question_id);
    const questionPrefix = `${QUESTION_PREFIX}: `;
    if (
      !question?.question.startsWith(questionPrefix) ||
      question.session_id !== event.target_session_id
    ) return;
    const service = question.question.slice(questionPrefix.length).trim();
    if (!service) return;
    const now = event.ts;
    const active = input.claims.listUnreleased().find((claim) =>
      claim.session_id === event.target_session_id && claim.service === service
    );
    if (!active) return;
    if (event.answer_index === 0 || /^extend$/i.test(event.answer_text)) {
      openTestingClaim(input.claims, { service: active.service, sessionId: active.session_id, branch: active.branch, note: "Vibes claim extension approved", now });
      input.sessions.mergeMetadata(active.session_id, { vibes_extension_requested_at: null, vibes_extension_question_id: null });
    } else {
      releaseTestingClaims(input.claims, { sessionId: active.session_id, service: active.service, now });
      input.sessions.setStatus(active.session_id, "blocked", now);
    }
  });
  return { stop: () => { clearInterval(timer); unsubscribe(); } };
}
