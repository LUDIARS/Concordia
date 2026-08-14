import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordPendingQuestionsRepo } from "../db/discord-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus } from "../events.js";
import { startVibesLifecycle } from "./vibes-lifecycle.js";

describe("startVibesLifecycle", () => {
  it("applies an extension answer to the service named by its question", () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const claims = new TestingClaimsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    sessions.insertSession({
      id: "session-1",
      provider: "codex-cli",
      repo_path: "E:/repo",
      repo_origin: "LUDIARS/Concordia",
      branch: "feat/vibes",
      host: "test-host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    });
    claims.claim({ service: "service-a", session_id: "session-1", now: 1 });
    claims.claim({ service: "service-b", session_id: "session-1", now: 2 });
    const question = questions.insert({
      session_id: "session-1",
      question: "Vibes testing claim has reached its time limit: service-a",
      options: ["Extend", "Stop"],
    });
    const handle = startVibesLifecycle({
      sessions,
      claims,
      questions,
      intervalMs: 60_000,
    });

    try {
      eventBus.emit({
        type: "question.answered",
        target_session_id: "session-1",
        question_id: question.id,
        answer_index: 0,
        answer_text: "Extend",
        ts: 100,
      });

      const unreleased = claims.listUnreleased();
      expect(unreleased.filter((claim) => claim.service === "service-a"))
        .toEqual([expect.objectContaining({ started_at: 100 })]);
      expect(unreleased.filter((claim) => claim.service === "service-b"))
        .toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("uses the team's vibes_defaults.claim_sec instead of the global default when resolved", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const claims = new TestingClaimsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    const now = Math.floor(Date.now() / 1000);
    sessions.insertSession({
      id: "session-team",
      provider: "codex-cli",
      repo_path: "E:/repo",
      repo_origin: "LUDIARS/Concordia",
      branch: "feat/vibes",
      host: "test-host",
      started_at: now,
      last_seen_at: now,
      transcript_path: null,
      metadata: null,
      team_id: "team-short-claim",
    });
    // claim が始まったのは十分過去 (グローバル既定 3600 秒未満・チーム既定 5 秒は超過)。
    claims.claim({ service: "service-a", session_id: "session-team", now: now - 30 });

    const handle = startVibesLifecycle({
      sessions,
      claims,
      questions,
      intervalMs: 20,
      resolveTeamClaimSec: (session) => (session.team_id === "team-short-claim" ? 5 : null),
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const question = questions.findUnansweredByQuestion(
        "session-team",
        "Vibes testing claim has reached its time limit: service-a",
      );
      expect(question).not.toBeNull();
    } finally {
      handle.stop();
    }
  });

  it("falls back to the global default claimSec when the session has no team (fallback)", async () => {
    const db = makeTestDb();
    const sessions = new SessionsRepo(db);
    const claims = new TestingClaimsRepo(db);
    const questions = makeDiscordPendingQuestionsRepo(db);
    const now = Math.floor(Date.now() / 1000);
    sessions.insertSession({
      id: "session-no-team",
      provider: "codex-cli",
      repo_path: "E:/repo",
      repo_origin: "LUDIARS/Concordia",
      branch: "feat/vibes",
      host: "test-host",
      started_at: now,
      last_seen_at: now,
      transcript_path: null,
      metadata: null,
    });
    // claim が始まったのはごく直近 (短い明示 claimSec=5 未満なので extend 質問は出ないはず)。
    claims.claim({ service: "service-a", session_id: "session-no-team", now });

    const handle = startVibesLifecycle({
      sessions,
      claims,
      questions,
      claimSec: 5,
      intervalMs: 20,
      resolveTeamClaimSec: () => null,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const question = questions.findUnansweredByQuestion(
        "session-no-team",
        "Vibes testing claim has reached its time limit: service-a",
      );
      expect(question).toBeNull();
    } finally {
      handle.stop();
    }
  });
});
