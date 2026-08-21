import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { isContractComplete, parseContractMetadata, type SessionContract } from "./schema.js";
import { saveContract } from "./store.js";
import { resolveTeamWorkLocation, type TeamContractSettings } from "./seed-rules.js";
import { applyContractModelEffort, type ApplyModelEffortFn } from "./runtime-apply.js";

export const TEAM_PREFIX = "Select the team for this repository";
const log = createChildLogger("contract-question-bridge");

interface TeamChoice {
  id: string;
  name: string;
}

export function postTeamQuestion(input: {
  questions: DiscordPendingQuestionsRepo;
  sessionId: string;
  teams: TeamChoice[];
}): void {
  const question = `${TEAM_PREFIX}: ${input.teams.map((team) => `${team.name}=${team.id}`).join(", ")}`;
  if (input.questions.findUnansweredByQuestion(input.sessionId, question)) return;
  const row = input.questions.insert({
    session_id: input.sessionId,
    question,
    options: input.teams.map((team) => ({ label: team.name, description: team.id })),
  });
  eventBus.emit({
    type: "question.posted",
    target_session_id: input.sessionId,
    question_id: row.id,
    question: row.question,
    options: JSON.parse(row.options_json),
    ts: row.ts,
  });
}

/**
 * plan/vibes の判断ダイアログ (契約カード) は 2026-08-21 に撤廃した。
 *
 * 判断そのものに意味が無く (回答は事実上いつも同じ)、 未回答の間は契約が未確定として
 * harness が編集を deny するため、 Task Workflow の委託セッションがカード待ちで止まる
 * 停止バグになっていた。 mode は seedSessionContract が決定論で決め切る。
 * 残るカードはチーム選択 (TEAM_PREFIX) だけ。
 */

export function startContractQuestionAnswers(input: {
  sessions: SessionsRepo;
  questions: DiscordPendingQuestionsRepo;
  resolveTeam?: (repo: string, name: string) => string | null;
  resolveTeamSettings?: (teamId: string) => TeamContractSettings | null;
  applyModelEffort?: ApplyModelEffortFn;
  onCompleted?: (sessionId: string, contract: SessionContract) => void;
}): { stop(): void } {
  const answer = async (event: ConcordiaEvent): Promise<void> => {
    if (event.type !== "question.answered") return;
    const row = input.questions.findById(event.question_id);
    if (!row || row.session_id !== event.target_session_id) return;
    const session = input.sessions.findSession(event.target_session_id);
    const contract = parseContractMetadata(session?.metadata ?? null);
    if (!session || !contract) return;
    const human = <T>(value: T, rationale: string) => ({
      value,
      decided_by: "human" as const,
      rationale,
      genius_card_ids: [],
    });

    if (row.question.startsWith(TEAM_PREFIX)) {
      const teamId = input.resolveTeam?.(session.repo_origin ?? session.repo_path, event.answer_text) ?? null;
      if (!teamId) return;
      input.sessions.patchSession(event.target_session_id, { team_id: teamId });
      const teamSettings = input.resolveTeamSettings?.(teamId) ?? null;
      const workLocation = resolveTeamWorkLocation(contract.mode?.value ?? null, teamSettings);
      const updated = saveContract(
        input.sessions,
        event.target_session_id,
        {
          ...contract,
          team: human(teamId, "Discord team direction answer"),
          ...(workLocation ? {
            work_location: human(
              workLocation,
              teamSettings?.worktree === "repo-root-only" ? "team settings: worktree=repo-root-only" : "契約 mode から導出",
            ),
          } : {}),
        },
        "team-question-answer",
        event.ts,
      );
      await applyModelEffortDecision(input, event.target_session_id, updated);
      if (isContractComplete(updated)) input.onCompleted?.(event.target_session_id, updated);
      return;
    }
  };
  return {
    stop: eventBus.subscribe((event) => {
      void answer(event).catch((error) => log.warn({ error }, "contract question answer failed"));
    }),
  };
}

async function applyModelEffortDecision(
  input: { sessions: SessionsRepo; applyModelEffort?: ApplyModelEffortFn },
  sessionId: string,
  contract: SessionContract,
): Promise<void> {
  if (!input.applyModelEffort) return;
  const result = await applyContractModelEffort({
    sessions: input.sessions,
    sessionId,
    contract,
    apply: input.applyModelEffort,
  });
  if (result.ok === false) {
    log.warn({ session_id: sessionId, message: result.message }, "contract question model/effort runtime apply failed");
  }
}
