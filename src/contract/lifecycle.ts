import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { parseContractMetadata } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";
import { saveContract } from "./store.js";
import { CONTRACT_FIELDS, type SessionContract } from "./schema.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { postContractQuestion, postTeamQuestion, startContractQuestionAnswers } from "./question-bridge.js";
import { undecidedFields } from "./seed-rules.js";
import type { ContractReviewPort } from "./review-port.js";
import { SessionContractSchema } from "./schema.js";
import { createChildLogger } from "../shared/logger.js";
const log = createChildLogger("session-contract");

export async function ensureSessionContract(sessions: SessionsRepo, sessionId: string, task: string, supervisor: string, questions?: DiscordPendingQuestionsRepo, review?: ContractReviewPort, resolveTeams?: (repo: string) => Array<{id:string;name:string}>): Promise<void> {
  const row = sessions.findSession(sessionId); if (!row) return;
  const existing = parseContractMetadata(row.metadata);
  // human override は常に最優先。task change でも同じフィールドを seed で上書きしない。
  const teams=resolveTeams?.(row.repo_origin??row.repo_path)??[];
  const selectedTeamId = row.team_id ?? (teams.length === 1 ? teams[0]!.id : null);
  const seeded = seedSessionContract(row, task, supervisor, selectedTeamId);
  if (!selectedTeamId && teams.length > 1) seeded.team = null;
  let merged = existing ? preserveHumanDecisions(seeded, existing) : seeded;
  if (review) {
    const reviewed = await review.review({ task, repoPath: row.repo_path, unresolved: undecidedFields(merged) as import("./schema.js").ContractField[], seeded: merged });
    const parsed = SessionContractSchema.safeParse({ ...merged, ...reviewed });
    if (parsed.success) merged = parsed.data;
  }
  saveContract(sessions, sessionId, merged, existing ? "task-change" : "spawn-or-first-instruction");
  if (questions) postContractQuestion({ questions, sessionId, unresolved: undecidedFields(merged) });
  if (questions && !selectedTeamId && teams.length > 1) {
    postTeamQuestion({ questions, sessionId, teams });
  }
}

function preserveHumanDecisions(seeded: SessionContract, existing: SessionContract): SessionContract {
  const merged: SessionContract = { ...seeded };
  for (const field of CONTRACT_FIELDS) {
    const decision = existing[field];
    if (decision?.decided_by === "human") Object.assign(merged, { [field]: decision });
  }
  return merged;
}

export function startContractLifecycle(input: { sessions: SessionsRepo; supervisor: () => string; questions?: DiscordPendingQuestionsRepo; reviewFor?: (provider: string) => ContractReviewPort | undefined; resolveService?: (repoName: string) => string | null | Promise<string | null>; resolveTeams?: (repo: string) => Array<{id:string;name:string}>; onCompleted?: (sessionId: string, contract: SessionContract) => void }): { stop(): void } {
  for (const row of input.sessions.listSessions({ status: "active" })) {
    if (!parseContractMetadata(row.metadata)) void ensureSessionContract(input.sessions, row.id, row.current_task ?? "session", input.supervisor(), input.questions, input.reviewFor?.(row.provider), input.resolveTeams).catch((error) => log.warn({ error, session_id: row.id }, "initial contract failed"));
  }
  const unsubscribe = eventBus.subscribe((event) => {
    const row = "session_id" in event && typeof event.session_id === "string"
      ? input.sessions.findSession(event.session_id)
      : null;
    if (event.type === "session.started") void ensureSessionContract(input.sessions, event.session_id, row?.current_task ?? "session", input.supervisor(), input.questions, row ? input.reviewFor?.(row.provider) : undefined, input.resolveTeams).catch((error) => log.warn({ error }, "spawn contract failed"));
    if (event.type === "session.task_changed" && event.current_task) void ensureSessionContract(input.sessions, event.session_id, event.current_task, input.supervisor(), input.questions, row ? input.reviewFor?.(row.provider) : undefined, input.resolveTeams).catch((error) => log.warn({ error }, "task contract failed"));
  });
  const answers = input.questions ? startContractQuestionAnswers({ sessions: input.sessions, questions: input.questions, resolveService: input.resolveService,resolveTeam:(repo,name)=>input.resolveTeams?.(repo).find(team=>team.name===name)?.id??null, onCompleted: input.onCompleted }) : null;
  return { stop: () => { unsubscribe(); answers?.stop(); } };
}
