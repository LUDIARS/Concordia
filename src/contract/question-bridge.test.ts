import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import { startContractQuestionAnswers, TEAM_PREFIX } from "./question-bridge.js";
import { parseContractMetadata } from "./schema.js";
import { seedSessionContract } from "./seed-rules.js";

// plan/vibes の契約カードは撤廃済み (spec/feature/session-contract.md §3.3)。
// 残る質問カードはチーム選択だけなので、 ここで守るのはその経路。
function makeSession(id: string, metadata: string | null = null): SessionRow {
  return {
    id,
    provider: "codex-cli",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/contract",
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata,
  } as SessionRow;
}

function insertSeeded(sessions: SessionsRepo, session: SessionRow, extraMetadata: Record<string, unknown> = {}): void {
  const contract = seedSessionContract(session, "small fix", "discord:1");
  sessions.insertSession({
    ...session,
    active_repos: [],
    metadata: JSON.stringify({ ...extraMetadata, contract }),
  });
}

describe("startContractQuestionAnswers", () => {
  it("別セッション宛のチーム回答は取り込まない", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    for (const id of ["session-a", "session-b"]) insertSeeded(sessions, makeSession(id));
    const question = questions.insert({
      session_id: "session-a",
      question: `${TEAM_PREFIX}: Unity=team-unity`,
      options: [{ label: "Unity", description: "team-unity" }],
    });
    const completed = vi.fn();
    const handle = startContractQuestionAnswers({
      sessions,
      questions,
      resolveTeam: () => "team-unity",
      onCompleted: completed,
    });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "session-b",
        question_id: question.id,
        answer_index: 0,
        answer_text: "Unity",
        ts: 2,
      });

      expect(sessions.findSession("session-b")?.team_id ?? null).toBeNull();
      expect(parseContractMetadata(sessions.findSession("session-b")?.metadata ?? null)?.team?.value).toBeNull();
      expect(completed).not.toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });

  it("seed 済みの mode に対して team settings の repo-root-only を後から効かせる", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    const session = makeSession("session-team-order");
    insertSeeded(sessions, session);
    // seed は「高リスク語なし」= vibes、 work_location は repo-root。
    expect(parseContractMetadata(sessions.findSession(session.id)?.metadata ?? null)?.work_location?.value)
      .toBe("repo-root");
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

  it("チーム回答で契約が揃ったら model/effort 決定を runtime へ反映する", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    const session = makeSession(
      "session-runtime-apply",
      JSON.stringify({ model: "gpt-5-codex", effort_level: "medium" }),
    );
    const contract = seedSessionContract(session, "small fix", "discord:1");
    contract.model = {
      value: "gpt-5.3-codex",
      decided_by: "llm",
      rationale: "review result",
      genius_card_ids: ["card-1"],
    };
    sessions.insertSession({
      ...session,
      active_repos: [],
      metadata: JSON.stringify({ model: "gpt-5-codex", effort_level: "medium", contract }),
    });
    const question = questions.insert({
      session_id: session.id,
      question: `${TEAM_PREFIX}: Unity=team-unity`,
      options: [{ label: "Unity", description: "team-unity" }],
    });
    const apply = vi.fn().mockResolvedValue({ ok: true, message: "switched" });
    const handle = startContractQuestionAnswers({
      sessions,
      questions,
      resolveTeam: () => "team-unity",
      applyModelEffort: apply,
    });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: session.id,
        question_id: question.id,
        answer_index: 0,
        answer_text: "Unity",
        ts: 2,
      });
      await vi.waitFor(() => {
        expect(apply).toHaveBeenCalledWith({
          sessionId: session.id,
          model: "gpt-5.3-codex",
          effort: "medium",
        });
      });
    } finally {
      handle.stop();
    }
  });
});
