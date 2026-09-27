import { expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import { HUMAN_WAIT_KEY, isHumanWaitActive, startHumanWait } from "./human-wait.js";

it("keeps explicit wait through automated injections and clears it on a human response", () => {
  const repo = new SessionsRepo(makeTestDb());
  repo.insertSession({ id: "s", provider: "codex-cli", repo_path: "/repo", repo_origin: null,
    branch: "feature", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null,
    metadata: JSON.stringify({ [HUMAN_WAIT_KEY]: { active: true, summary: "判断待ち", task_references: ["actio:T-1"], since: 1 } }) });
  const handle = startHumanWait(repo);
  try {
    eventBus.emit({ type: "session.inject", target_session_id: "s", text: "automatic", source: "auto:goal-and-go", ts: 2 });
    expect(isHumanWaitActive(repo, "s")).toBe(true);
    eventBus.emit({ type: "session.inject", target_session_id: "s", text: "generated from a reaction", source: "reaction-workflow",
      provenance: { actorId: "human" } as never, ts: 2 });
    expect(isHumanWaitActive(repo, "s")).toBe(true);
    eventBus.emit({ type: "session.inject", target_session_id: "s", text: "answer", source: "discord:human:channel:message", ts: 3 });
    expect(isHumanWaitActive(repo, "s")).toBe(false);
  } finally { handle.stop(); }
});

it("does not mistake a local keystroke for a submitted answer", () => {
  const repo = new SessionsRepo(makeTestDb());
  repo.insertSession({ id: "s", provider: "codex-cli", repo_path: "/repo", repo_origin: null,
    branch: "feature", host: "test", started_at: 1, last_seen_at: 1, transcript_path: null,
    metadata: JSON.stringify({ [HUMAN_WAIT_KEY]: { active: true, summary: "decision pending", task_references: [], since: 1 } }) });
  const handle = startHumanWait(repo);
  try {
    eventBus.emit({ type: "session.event", session_id: "s", kind: "user_activity", ts: 2 });
    expect(isHumanWaitActive(repo, "s")).toBe(true);
    eventBus.emit({ type: "question.answered", target_session_id: "s", question_id: 1,
      answer_index: 0, answer_text: "approved", ts: 3 });
    expect(isHumanWaitActive(repo, "s")).toBe(false);
  } finally { handle.stop(); }
});
