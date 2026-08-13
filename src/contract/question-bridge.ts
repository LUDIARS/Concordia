import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { createChildLogger } from "../shared/logger.js";
import { isContractComplete, parseContractMetadata, type SessionContract } from "./schema.js";
import { saveContract } from "./store.js";

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

const PREFIX = "セッション契約の未決項目";
export function postContractQuestion(input: {
  questions: DiscordPendingQuestionsRepo;
  sessionId: string;
  unresolved: string[];
}): number | null {
  if (input.unresolved.length === 0 || input.questions.findUnansweredByQuestion(input.sessionId, `${PREFIX}: ${input.unresolved.join(", ")}`)) return null;
  const row = input.questions.insert({
    session_id: input.sessionId,
    question: `${PREFIX}: ${input.unresolved.join(", ")}`,
    options: [
      { label: "plan", description: "設問・設計・承認後に実装" },
      { label: "vibes", description: "testing claim 下で目視調整" },
    ],
  });
  eventBus.emit({
    type: "question.posted",
    target_session_id: input.sessionId,
    question_id: row.id,
    question: row.question,
    options: JSON.parse(row.options_json),
    ts: row.ts,
  });
  return row.id;
}

export function startContractQuestionAnswers(input: {
  sessions: SessionsRepo;
  questions: DiscordPendingQuestionsRepo;
  resolveService?: (repoName: string) => string | null | Promise<string | null>;
  resolveTeam?: (repo: string, name: string) => string | null;
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
      const updated = saveContract(
        input.sessions,
        event.target_session_id,
        { ...contract, team: human(teamId, "Discord team direction answer") },
        "team-question-answer",
        event.ts,
      );
      if (isContractComplete(updated)) input.onCompleted?.(event.target_session_id, updated);
      return;
    }
    if (!row.question.startsWith(PREFIX)) return;
    const normalizedAnswer = event.answer_text.trim().toLowerCase();
    if (normalizedAnswer !== "vibes" && normalizedAnswer !== "plan") return;
    const mode = normalizedAnswer;
    const service = mode === "vibes" ? await input.resolveService?.(session.target_project ?? session.repo_path) ?? null : null;
    const completed: SessionContract = {
      ...contract,
      mode: human(mode, "契約カード回答"),
      model: contract.model ?? human(session.provider, "契約カードで現runtime維持"),
      effort: contract.effort ?? human("medium", "契約カードで既定effort維持"),
      work_location: human(mode === "vibes" ? "repo-root" : "worktree", "mode回答から導出"),
      acceptance: human(mode === "vibes" ? "human-ok" : "plan", "mode回答から導出"),
      testing_claim: service || mode === "plan"
        ? human({ required: mode === "vibes", service }, "Excubitor catalog service resolver")
        : null,
    };
    const updated = saveContract(input.sessions, event.target_session_id, completed, "contract-question-answer", event.ts);
    if (isContractComplete(updated)) input.onCompleted?.(event.target_session_id, updated);
  };
  return {
    stop: eventBus.subscribe((event) => {
      void answer(event).catch((error) => log.warn({ error }, "contract question answer failed"));
    }),
  };
}
