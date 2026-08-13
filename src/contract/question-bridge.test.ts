import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import { startContractQuestionAnswers } from "./question-bridge.js";
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
});
