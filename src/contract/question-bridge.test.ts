import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import { startContractQuestionAnswers, TEAM_PREFIX } from "./question-bridge.js";
import { parseContractMetadata } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";

describe("startContractQuestionAnswers", () => {
  it("rejects cross-session and non-enumerated contract answers", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    for (const id of ["session-a", "session-b"]) {
      const session = {
        id,
        provider: "codex-cli",
        repo_path: "E:/repo",
        repo_origin: "LUDIARS/Concordia",
        branch: "feat/contract",
        host: "test-host",
        started_at: 1,
        last_seen_at: 1,
        transcript_path: null,
        metadata: null,
      } as SessionRow;
      const contract = seedSessionContract(session, "small fix", "discord:1");
      sessions.insertSession({ ...session, active_repos: [], metadata: JSON.stringify({ contract }) });
    }
    const question = questions.insert({
      session_id: "session-a",
      question: "セッション契約の未決項目: mode",
      options: ["plan", "vibes"],
    });
    const completed = vi.fn();
    const handle = startContractQuestionAnswers({ sessions, questions, onCompleted: completed });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "session-b",
        question_id: question.id,
        answer_index: 0,
        answer_text: "plan",
        ts: 2,
      });
      eventBus.emit({
        type: "question.answered",
        target_session_id: "session-a",
        question_id: question.id,
        answer_index: -1,
        answer_text: "other",
        ts: 3,
      });

      expect(parseContractMetadata(sessions.findSession("session-a")?.metadata ?? null)?.mode).toBeNull();
      expect(parseContractMetadata(sessions.findSession("session-b")?.metadata ?? null)?.mode).toBeNull();
      expect(completed).not.toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });

  it("reapplies repo-root-only after mode is answered before the team question", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    const session = {
      id: "session-team-order",
      provider: "codex-cli",
      repo_path: "E:/repo",
      repo_origin: "LUDIARS/Concordia",
      branch: "feat/contract",
      host: "test-host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    } as SessionRow;
    const contract = seedSessionContract(session, "small fix", "discord:1");
    sessions.insertSession({ ...session, active_repos: [], metadata: JSON.stringify({ contract }) });
    const modeQuestion = questions.insert({
      session_id: session.id,
      question: "セッション契約の未決項目: mode",
      options: ["plan", "vibes"],
    });
    const teamQuestion = questions.insert({
      session_id: session.id,
      question: `${TEAM_PREFIX}: Unity=team-unity`,
      options: [{ label: "Unity", description: "team-unity" }],
    });
    const handle = startContractQuestionAnswers({
      sessions,
      questions,
      resolveTeam: () => "team-unity",
      resolveTeamSettings: () => ({ worktree: "repo-root-only" }),
    });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: session.id,
        question_id: modeQuestion.id,
        answer_index: 0,
        answer_text: "plan",
        ts: 2,
      });
      expect(parseContractMetadata(sessions.findSession(session.id)?.metadata ?? null)?.work_location?.value)
        .toBe("worktree");

      eventBus.emit({
        type: "question.answered",
        target_session_id: session.id,
        question_id: teamQuestion.id,
        answer_index: 0,
        answer_text: "Unity",
        ts: 3,
      });
      const updated = parseContractMetadata(sessions.findSession(session.id)?.metadata ?? null);
      expect(updated?.team?.value).toBe("team-unity");
      expect(updated?.work_location?.value).toBe("repo-root");
    } finally {
      handle.stop();
    }
  });
});
