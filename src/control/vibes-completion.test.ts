import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { eventBus } from "../events.js";
import { startVibesCompletion } from "./vibes-completion.js";

function contractMetadata(mode: "plan" | "vibes"): string {
  const value = <T>(v: T) => ({ value: v, decided_by: "human", rationale: "test", genius_card_ids: [] });
  return JSON.stringify({
    contract: {
      version: 1,
      mode: value(mode),
      team: null,
      model: null,
      effort: null,
      work_branch: null,
      work_location: null,
      scope_dirs: null,
      acceptance: null,
      goal_and_go: null,
      continuation: null,
      testing_claim: null,
      supervisor: null,
    },
  });
}

function setup(input: { metadata: string | null }) {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const claims = new TestingClaimsRepo(db);
  sessions.insertSession({
    id: "session-1",
    provider: "claude-code",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/Concordia",
    branch: "feat/vibes",
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: input.metadata,
  });
  claims.claim({ service: "service-a", session_id: "session-1", now: 1 });
  return { sessions, claims };
}

describe("startVibesCompletion", () => {
  it("[OK] → PR 提出受理 → claim release → vibes-completed → endSession の連鎖", async () => {
    const { sessions, claims } = setup({ metadata: contractMetadata("vibes") });
    const submitLocalPr = vi.fn(async () => ({ submitted: true }));
    const endSession = vi.fn(async (_session: { id: string }, _reason: string) => undefined);
    const handle = startVibesCompletion({ sessions, claims, submitLocalPr, endSession, nowSec: () => 200 });
    try {
      eventBus.emit({ type: "vibes.ok", session_id: "session-1", source: "discord", ts: 100 });
      await vi.waitFor(() => expect(endSession).toHaveBeenCalledOnce());
      expect(submitLocalPr).toHaveBeenCalledWith("session-1");
      expect(endSession.mock.calls[0]![0]!.id).toBe("session-1");
      expect(endSession.mock.calls[0]![1]).toBe("vibes-human-ok");
      expect(sessions.eventsByKind("session-1", "vibes-human-ok")).toHaveLength(1);
      expect(sessions.eventsByKind("session-1", "vibes-completed")).toHaveLength(1);
      expect(claims.listActive(300)).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });

  it("resubmitted も受理として扱う", async () => {
    const { sessions, claims } = setup({ metadata: contractMetadata("vibes") });
    const submitLocalPr = vi.fn(async () => ({ submitted: false, resubmitted: true }));
    const endSession = vi.fn(async () => undefined);
    const handle = startVibesCompletion({ sessions, claims, submitLocalPr, endSession, nowSec: () => 200 });
    try {
      eventBus.emit({ type: "vibes.ok", session_id: "session-1", source: "discord", ts: 100 });
      await vi.waitFor(() => expect(endSession).toHaveBeenCalledOnce());
      expect(sessions.eventsByKind("session-1", "vibes-completed")).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("PR 提出が受理されなければ vibes-pr-failed で連鎖を打ち切る (claim 保持・終了しない)", async () => {
    const { sessions, claims } = setup({ metadata: contractMetadata("vibes") });
    const submitLocalPr = vi.fn(async () => ({ submitted: false, reason: "error" }));
    const endSession = vi.fn(async () => undefined);
    const handle = startVibesCompletion({ sessions, claims, submitLocalPr, endSession, nowSec: () => 200 });
    try {
      eventBus.emit({ type: "vibes.ok", session_id: "session-1", source: "discord", ts: 100 });
      await vi.waitFor(() => expect(sessions.eventsByKind("session-1", "vibes-pr-failed")).toHaveLength(1));
      expect(sessions.eventsByKind("session-1", "vibes-human-ok")).toHaveLength(1);
      expect(sessions.eventsByKind("session-1", "vibes-completed")).toHaveLength(0);
      expect(endSession).not.toHaveBeenCalled();
      expect(claims.listActive(300)).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("vibes 契約でないセッションは対象外 (提出もイベントも起きない)", async () => {
    const { sessions, claims } = setup({ metadata: contractMetadata("plan") });
    const submitLocalPr = vi.fn(async () => ({ submitted: true }));
    const endSession = vi.fn(async () => undefined);
    const handle = startVibesCompletion({ sessions, claims, submitLocalPr, endSession });
    try {
      eventBus.emit({ type: "vibes.ok", session_id: "session-1", source: "discord", ts: 100 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(submitLocalPr).not.toHaveBeenCalled();
      expect(sessions.eventsByKind("session-1", "vibes-human-ok")).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });
});
