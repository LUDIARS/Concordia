import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { parseContractMetadata } from "./schema.js";
import { seedSessionContract, type TeamContractSettings } from "./seed-rules.js";
import { saveContract } from "./store.js";
import { CONTRACT_FIELDS, type SessionContract } from "./schema.js";
import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { postTeamQuestion, startContractQuestionAnswers } from "./question-bridge.js";
import { readRuntimeEffort, readRuntimeModel, undecidedFields } from "./seed-rules.js";
import type { ContractReviewPort } from "./review-port.js";
import { SessionContractSchema } from "./schema.js";
import { applyContractModelEffort, type ApplyModelEffortFn } from "./runtime-apply.js";
import { createChildLogger } from "../shared/logger.js";
const log = createChildLogger("session-contract");

type TeamCandidate = { id: string; name: string; settings: TeamContractSettings };

type ResolveTeams = (repo: string) => TeamCandidate[];
type ResolveTeamSettings = (teamId: string) => TeamContractSettings | null;

interface ContractLifecycleInput {
  sessions: SessionsRepo;
  supervisor: () => string;
  questions?: DiscordPendingQuestionsRepo;
  reviewFor?: (provider: string) => ContractReviewPort | undefined;
  resolveService?: (repoName: string) => string | null | Promise<string | null>;
  resolveTeams?: ResolveTeams;
  resolveTeamSettings?: ResolveTeamSettings;
  /** 契約の model / effort 決定 (llm / human) を Lictor runtime へ反映する口。 */
  applyModelEffort?: ApplyModelEffortFn;
  onCompleted?: (sessionId: string, contract: SessionContract) => void;
}

export async function ensureSessionContract(
  sessions: SessionsRepo,
  sessionId: string,
  task: string,
  supervisor: string,
  questions?: DiscordPendingQuestionsRepo,
  review?: ContractReviewPort,
  resolveTeams?: ResolveTeams,
  resolveTeamSettings?: ResolveTeamSettings,
  applyModelEffort?: ApplyModelEffortFn,
  trigger?: "spawn" | "task-change",
  resolveService?: (repoName: string) => string | null | Promise<string | null>,
): Promise<void> {
  const row = sessions.findSession(sessionId); if (!row) return;
  const existing = parseContractMetadata(row.metadata);
  // human override は常に最優先。task change でも同じフィールドを seed で上書きしない。
  const teams=resolveTeams?.(row.repo_origin??row.repo_path)??[];
  const selectedTeamId = row.team_id ?? (teams.length === 1 ? teams[0]!.id : null);
  const selectedTeamSettings = selectedTeamId
    ? resolveTeamSettings?.(selectedTeamId) ?? teams.find((team) => team.id === selectedTeamId)?.settings ?? null
    : null;
  const seeded = seedSessionContract(row, task, supervisor, selectedTeamId, selectedTeamSettings);
  if (!selectedTeamId && teams.length > 1) seeded.team = null;
  let merged = existing ? preserveHumanDecisions(seeded, existing) : seeded;
  if (review) {
    const reviewed = await review.review({
      trigger: trigger ?? (existing ? "task-change" : "spawn"),
      task,
      repoPath: row.repo_path,
      unresolved: undecidedFields(merged) as import("./schema.js").ContractField[],
      seeded: merged,
    });
    const parsed = SessionContractSchema.safeParse({ ...merged, ...reviewed });
    if (parsed.success) merged = parsed.data;
  }
  merged = await finalizeContract(merged, row, resolveService);
  saveContract(sessions, sessionId, merged, existing ? "task-change" : "spawn-or-first-instruction");
  if (applyModelEffort) {
    const applied = await applyContractModelEffort({ sessions, sessionId, contract: merged, apply: applyModelEffort });
    if (applied.ok === false) log.warn({ session_id: sessionId, message: applied.message }, "contract model/effort runtime apply failed");
  }
  const stillUndecided = undecidedFields(merged);
  if (stillUndecided.length > 0) log.warn({ session_id: sessionId, fields: stillUndecided }, "contract left undecided after finalize");
  if (questions && !selectedTeamId && teams.length > 1) {
    postTeamQuestion({ questions, sessionId, teams });
  }
}

/**
 * 契約を決定論で埋め切る。 未決フィールドが残ると harness の contract-incomplete が
 * 編集を deny してセッションが止まるため、 質問カードに頼らず最後まで詰める
 * (2026-08-21: plan/vibes 判断ダイアログの撤廃に伴う backstop)。
 *
 * - model / effort: LLM tier (review-port) が決めなかったら現 runtime を採る。
 * - team: 複数チーム repo は選択カードを待つ間も null にしない。 未選択を明示した
 *   `value: null` の seed で埋め、 契約自体は成立させる。 カードに回答が付けば
 *   question-bridge が `decided_by: "human"` で上書きする (§3.3 の残るカード)。
 *   ここを埋めないと isContractComplete が永久に false になり、 撤廃したはずの
 *   contract-incomplete 停止が複数チーム repo でだけ残る。
 * - testing_claim: vibes で service が解決できたら seed の未解決値を差し替える。
 */
async function finalizeContract(
  contract: SessionContract,
  row: { metadata: string | null; provider: string; target_project: string | null; repo_path: string },
  resolveService?: (repoName: string) => string | null | Promise<string | null>,
): Promise<SessionContract> {
  const seed = <T>(value: T, rationale: string) => ({ value, decided_by: "seed" as const, rationale, genius_card_ids: [] });
  const finalized: SessionContract = {
    ...contract,
    model: contract.model ?? seed(readRuntimeModel(row.metadata) ?? row.provider, "runtime 既定を維持"),
    effort: contract.effort ?? seed(readRuntimeEffort(row.metadata) ?? "medium", "runtime 既定を維持"),
    team: contract.team ?? seed(null, "チーム選択カードの回答待ち (未選択のまま契約を成立させる)"),
  };
  if (finalized.mode?.value === "vibes" && finalized.testing_claim?.value.service == null && resolveService) {
    try {
      const service = await resolveService(row.target_project ?? row.repo_path);
      if (service) finalized.testing_claim = seed({ required: true, service }, "Excubitor catalog service resolver");
    } catch (error) {
      log.warn({ error }, "vibes testing service resolution failed");
    }
  }
  return finalized;
}

function preserveHumanDecisions(seeded: SessionContract, existing: SessionContract): SessionContract {
  const merged: SessionContract = { ...seeded };
  for (const field of CONTRACT_FIELDS) {
    const decision = existing[field];
    if (decision?.decided_by === "human") Object.assign(merged, { [field]: decision });
  }
  return merged;
}

export function startContractLifecycle(input: ContractLifecycleInput): { stop(): void } {
  for (const row of input.sessions.listSessions({ status: "active" })) {
    if (!parseContractMetadata(row.metadata)) void ensureSessionContract(input.sessions, row.id, row.current_task ?? "session", input.supervisor(), input.questions, input.reviewFor?.(row.provider), input.resolveTeams, input.resolveTeamSettings, input.applyModelEffort, "spawn", input.resolveService).catch((error) => log.warn({ error, session_id: row.id }, "initial contract failed"));
  }
  const unsubscribe = eventBus.subscribe((event) => {
    const row = "session_id" in event && typeof event.session_id === "string"
      ? input.sessions.findSession(event.session_id)
      : null;
    if (event.type === "session.started") void ensureSessionContract(input.sessions, event.session_id, row?.current_task ?? "session", input.supervisor(), input.questions, row ? input.reviewFor?.(row.provider) : undefined, input.resolveTeams, input.resolveTeamSettings, input.applyModelEffort, "spawn", input.resolveService).catch((error) => log.warn({ error }, "spawn contract failed"));
    if (event.type === "session.task_changed" && event.current_task) void ensureSessionContract(input.sessions, event.session_id, event.current_task, input.supervisor(), input.questions, row ? input.reviewFor?.(row.provider) : undefined, input.resolveTeams, input.resolveTeamSettings, input.applyModelEffort, "task-change", input.resolveService).catch((error) => log.warn({ error }, "task contract failed"));
  });
  const answers = input.questions ? startContractQuestionAnswers({
    sessions: input.sessions,
    questions: input.questions,
    resolveTeam: (repo, name) => input.resolveTeams?.(repo).find((team) => team.name === name)?.id ?? null,
    resolveTeamSettings: input.resolveTeamSettings,
    applyModelEffort: input.applyModelEffort,
    onCompleted: input.onCompleted,
  }) : null;
  return { stop: () => { unsubscribe(); answers?.stop(); } };
}
