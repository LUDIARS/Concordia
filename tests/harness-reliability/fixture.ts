import { vi } from "vitest";
import { makeTestDb } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { SessionMessagesRepo } from "../../src/db/session-messages-repo.js";
import { ReliabilityStore } from "../../src/harness/reliability/store.js";
import { ReliabilityHookService } from "../../src/harness/reliability/hook-service.js";

/** No real CLI, Discord, HTTP or service lifecycle. All external boundaries are explicit fakes. */
export function makeReliabilityFixture() {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const messages = new SessionMessagesRepo(db);
  let at = Date.UTC(2026, 8, 10);
  sessions.insertSession({ id: "fixture-session", provider: "codex-cli", repo_path: "fixture/repo", repo_origin: null,
    branch: "feature/fixture", host: "fixture", started_at: at / 1000, last_seen_at: at / 1000,
    transcript_path: null, metadata: JSON.stringify({ goal: "implement accepted task", unrelated: "preserve" }) });
  const store = new ReliabilityStore(sessions);
  const notify = vi.fn(() => 1);
  const assess = vi.fn();
  const service = new ReliabilityHookService({ sessions, messages, store, pendingQuestions: () => [{ question: "waiting for human decision" }],
    acceptanceManifest: () => ({ status: "absent", criteria: [] }),
    notify, assess, now: () => at, random: () => 0.1 });
  return { id: "fixture-session", sessions, messages, store, service, notify, assess, now: () => at, advance: (ms: number) => { at += ms; } };
}
