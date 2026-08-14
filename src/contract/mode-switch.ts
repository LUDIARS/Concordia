/**
 * vibes ↔ plan のモード切替を「契約更新」として扱う境界。
 * spec/feature/plan-gate.md §5 / spec/feature/vibes-mode.md §3。
 *
 * - 昇格 (vibes → plan): vibes-file-limit の質問カード回答、 または明示 API で行う。
 *   封鎖を閉じる方向なので即時適用してよい。 適用時に testing claim を release し、
 *   `plan_approved` を false に戻して plan gate (planUnapproved) を有効化する。
 * - 降格 (plan → vibes): 封鎖を開ける方向は常に人間。 API は承認質問カードを投稿する
 *   だけで、 実際の契約更新は人間の承認回答 (question.answered) だけが行う。
 *
 * どちらも human tier の契約決定として保存されるため、 task-change 再シードでも
 * preserveHumanDecisions (lifecycle.ts) が保持する。
 */

import type { DiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { releaseTestingClaims } from "../testing/claim-lifecycle.js";
import { createChildLogger } from "../shared/logger.js";
import { parseContractMetadata, type SessionContract } from "./schema.js";
import { resolveTeamWorkLocation, type TeamContractSettings } from "./seed-rules.js";
import { saveContract } from "./store.js";

const log = createChildLogger("contract-mode-switch");

/** vibes-file-limit 述語発火時に投稿される昇格質問 (register-core の onVibesFileLimit と共有)。 */
export const VIBES_PROMOTION_QUESTION = "Vibes mode reached its edited-file limit. Promote this task to plan mode?";
export const VIBES_PROMOTION_OPTIONS = [
  { label: "Promote to plan", description: "Release the testing claim and enter design approval." },
  { label: "Stop", description: "Keep the current branch and block this run." },
] as const;

/** 降格承認カードの質問プレフィクス (後続には表示用に無害化した要求理由が続く)。 */
export const DEMOTION_QUESTION_PREFIX = "Demote this plan-mode session to vibes?";
export const DEMOTION_OPTIONS = [
  { label: "Approve demotion", description: "Switch the contract to vibes (human-ok acceptance)." },
  { label: "Keep plan", description: "Stay in plan mode; the edit gate holds until plan approval." },
] as const;

function human<T>(value: T, rationale: string) {
  return { value, decided_by: "human" as const, rationale, genius_card_ids: [] };
}

function approvalCardRationale(value: string): string {
  // Slack の mrkdwn mention/link/code 構文と改行による偽選択肢を無効化する。
  return value.replace(/[\r\n\t]+/g, " ").replace(/[`<>]/g, "").replace(/\s+/g, " ").trim();
}

export interface PromoteDeps {
  sessions: SessionsRepo;
  claims?: TestingClaimsRepo;
  resolveTeamSettings?: (teamId: string) => TeamContractSettings | null;
}

/**
 * vibes → plan 昇格を即時適用する (封鎖を閉じる方向なので承認カードは不要)。
 * testing claim release + plan_approved=false で plan gate を必ず立て直す。
 * 既に plan の契約には冪等 (no-op で現契約を返す)。
 */
export function promoteContractToPlan(
  deps: PromoteDeps,
  sessionId: string,
  rationale: string,
  now = Math.floor(Date.now() / 1000),
): SessionContract | null {
  const row = deps.sessions.findSession(sessionId);
  const contract = parseContractMetadata(row?.metadata ?? null);
  if (!row || !contract) return null;
  if (contract.mode?.value === "plan") return contract;
  const teamSettings = contract.team?.value ? deps.resolveTeamSettings?.(contract.team.value) ?? null : null;
  const updated = saveContract(
    deps.sessions,
    sessionId,
    {
      ...contract,
      mode: human("plan", rationale),
      acceptance: human("plan", "plan mode の受け入れ経路"),
      work_location: human(
        resolveTeamWorkLocation("plan", teamSettings)!,
        teamSettings?.worktree === "repo-root-only" ? "team settings: worktree=repo-root-only" : "mode昇格から導出",
      ),
      testing_claim: human({ required: false, service: null }, "plan は testing claim 不要"),
    },
    "mode-switch-promotion",
    now,
  );
  // 昇格したセッションは設問フェーズからやり直す — 過去の承認を持ち越さない。
  deps.sessions.mergeMetadata(sessionId, { plan_approved: false });
  if (deps.claims) releaseTestingClaims(deps.claims, { sessionId, now });
  return updated;
}

export type DemotionRequestResult =
  | { ok: true; question_id: number }
  | { ok: false; error: "not_found" | "not_plan_mode" | "already_pending" };

/**
 * plan → vibes 降格の承認カードを投稿する。 契約はここでは一切変更しない —
 * 変更は人間の承認回答 (startModeSwitchAnswers) だけが行う。
 */
export function requestContractDemotion(
  deps: { sessions: SessionsRepo; questions: DiscordPendingQuestionsRepo },
  sessionId: string,
  rationale: string,
): DemotionRequestResult {
  const row = deps.sessions.findSession(sessionId);
  const contract = parseContractMetadata(row?.metadata ?? null);
  if (!row || !contract) return { ok: false, error: "not_found" };
  if (contract.mode?.value !== "plan") return { ok: false, error: "not_plan_mode" };
  const question = `${DEMOTION_QUESTION_PREFIX} Reason: ${approvalCardRationale(rationale)}`;
  if (deps.questions.findUnansweredByQuestion(sessionId, question)) return { ok: false, error: "already_pending" };
  const inserted = deps.questions.insert({ session_id: sessionId, question, options: [...DEMOTION_OPTIONS] });
  eventBus.emit({
    type: "question.posted",
    target_session_id: sessionId,
    question_id: inserted.id,
    question: inserted.question,
    options: JSON.parse(inserted.options_json),
    ts: inserted.ts,
  });
  return { ok: true, question_id: inserted.id };
}

export interface ModeSwitchAnswersInput {
  sessions: SessionsRepo;
  questions: DiscordPendingQuestionsRepo;
  claims?: TestingClaimsRepo;
  resolveService?: (repoName: string) => string | null | Promise<string | null>;
  resolveTeamSettings?: (teamId: string) => TeamContractSettings | null;
  /** 降格が human 承認で確定したとき (vibes claim 自動取得の配線先)。 */
  onDemoted?: (sessionId: string, contract: SessionContract) => void;
}

/**
 * モード切替に関わる質問カードの回答を消費する購読者。
 * - 昇格カード (VIBES_PROMOTION_QUESTION): Promote → promoteContractToPlan、
 *   Stop → claim release + session blocked (カードの記載どおり)。
 * - 降格カード (DEMOTION_QUESTION_PREFIX): Approve → vibes 契約へ human tier で更新。
 *   それ以外の回答は契約に触れない (承認なしの降格は起こらない)。
 */
export function startModeSwitchAnswers(input: ModeSwitchAnswersInput): { stop(): void } {
  const answer = async (event: ConcordiaEvent): Promise<void> => {
    if (event.type !== "question.answered") return;
    const row = input.questions.findById(event.question_id);
    if (!row || row.session_id !== event.target_session_id) return;
    const session = input.sessions.findSession(event.target_session_id);
    const contract = parseContractMetadata(session?.metadata ?? null);
    if (!session || !contract) return;

    if (row.question === VIBES_PROMOTION_QUESTION) {
      if (contract.mode?.value !== "vibes") return;
      if (event.answer_index === 0) {
        promoteContractToPlan(input, event.target_session_id, "vibes-file-limit 昇格回答", event.ts);
      } else if (event.answer_index === 1) {
        if (input.claims) releaseTestingClaims(input.claims, { sessionId: session.id, now: event.ts });
        input.sessions.setStatus(session.id, "blocked", event.ts);
        input.sessions.appendEvent({ session_id: session.id, ts: event.ts, kind: "contract", payload: { reason: "vibes-file-limit-stop" } });
      }
      return;
    }

    if (!row.question.startsWith(DEMOTION_QUESTION_PREFIX)) return;
    if (contract.mode?.value !== "plan") return;
    // 質問 UI は常に自由入力 (answer_index=-1) を提供する。封鎖を開ける降格は
    // 明示的な「Approve demotion」選択だけに限定し、自由文を承認として解釈しない。
    if (event.answer_index !== 0) {
      input.sessions.appendEvent({ session_id: session.id, ts: event.ts, kind: "contract", payload: { reason: "mode-demotion-rejected" } });
      return;
    }
    const service = await input.resolveService?.(session.target_project ?? session.repo_path) ?? null;
    // service 解決は非同期になり得る。待機中の別契約更新を古い snapshot で上書きしない。
    const currentSession = input.sessions.findSession(event.target_session_id);
    const currentContract = parseContractMetadata(currentSession?.metadata ?? null);
    if (!currentSession || currentContract?.mode?.value !== "plan") return;
    const teamSettings = currentContract.team?.value
      ? input.resolveTeamSettings?.(currentContract.team.value) ?? null
      : null;
    const updated = saveContract(
      input.sessions,
      currentSession.id,
      {
        ...currentContract,
        mode: human("vibes", "plan→vibes 降格の人間承認"),
        acceptance: human("human-ok", "mode降格から導出"),
        work_location: human(
          resolveTeamWorkLocation("vibes", teamSettings)!,
          teamSettings?.worktree === "repo-root-only" ? "team settings: worktree=repo-root-only" : "mode降格から導出",
        ),
        testing_claim: human(
          { required: true, service },
          service ? "Excubitor catalog service resolver" : "service 未解決 (claim は手動取得)",
        ),
      },
      "mode-switch-demotion",
      event.ts,
    );
    input.onDemoted?.(currentSession.id, updated);
  };
  return {
    stop: eventBus.subscribe((event) => {
      void answer(event).catch((error) => log.warn({ error }, "mode switch answer failed"));
    }),
  };
}
