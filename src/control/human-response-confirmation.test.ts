import { describe, expect, it } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { claimHumanResponseConfirmation, isWaitingForHumanResponse, startHumanResponseConfirmation } from "./human-response-confirmation.js";
import { checkResidual } from "../taskflow/residual-blackbox.js";
import type { TaskMdStore } from "../taskflow/md-store.js";
import { startPhaseCompaction } from "./phase-compaction.js";

function harness() {
  const row = { id: "session", status: "active", metadata: "{}", repo_path: "/repo" } as SessionRow;
  const events: object[] = [];
  const repo = {
    findSession: () => row,
    // Mirrors SessionsRepo.mergeMetadata: an unparseable blob is replaced, not thrown on.
    mergeMetadata: (_id: string, patch: object) => {
      let current: object = {};
      try { current = JSON.parse(row.metadata ?? "{}") as object; } catch { current = {}; }
      row.metadata = JSON.stringify({ ...current, ...patch });
    },
    appendEvent: (event: object) => { events.push(event); },
  } as unknown as SessionsRepo;
  return { row, repo, events };
}

describe("human response confirmation", () => {
  it("keeps the latch across listener restart and AI/automatic output, then reopens on human input", () => {
    const h = harness();
    let watch = startHumanResponseConfirmation(h.repo);
    try {
      expect(claimHumanResponseConfirmation(h.repo, "session")).toBe(true);
      watch.stop();
      watch = startHumanResponseConfirmation(h.repo);
      eventBus.emit({ type: "session.event", session_id: "session", kind: "final_answer", ts: 1 } as ConcordiaEvent);
      eventBus.emit({ type: "session.inject", target_session_id: "session", source: "revisor", text: "Test OK", ts: 2 });
      eventBus.emit({ type: "transcript.frame", target_session_id: "session", kind: "text", payload: { role: "user", text: "automated prompt" }, ts: 3 } as ConcordiaEvent);
      expect(claimHumanResponseConfirmation(h.repo, "session")).toBe(false);
      eventBus.emit({ type: "session.inject", target_session_id: "session", source: "discord:human:channel:message", text: "continue", ts: 4 });
      expect(claimHumanResponseConfirmation(h.repo, "session")).toBe(true);
      expect(claimHumanResponseConfirmation(h.repo, "session")).toBe(false);
      eventBus.emit({ type: "question.answered", target_session_id: "session", question_id: 1, answer_index: 0, answer_text: "continue", ts: 5 });
      expect(claimHumanResponseConfirmation(h.repo, "session")).toBe(true);
    } finally { watch.stop(); }
  });

  it("coalesces repeated residual checks and emits no new phase event while waiting", async () => {
    const h = harness();
    const observed: ConcordiaEvent[] = [];
    const stop = eventBus.subscribe((event) => observed.push(event));
    const input = { sessionId: "session", sessions: h.repo, store: { findForProject: async () => [] } as unknown as TaskMdStore };
    try {
      expect(await Promise.all([checkResidual(input), checkResidual(input)])).toEqual(["decompose", "waiting"]);
      expect(await checkResidual(input)).toBe("waiting");
      expect(observed.filter((event) => event.type === "taskflow.residual_checked")).toHaveLength(1);
      expect(h.events).toHaveLength(1);
    } finally { stop(); }
  });

  it("pending questions suppress both decomposition and its phase handoff without claiming", async () => {
    const h = harness();
    const input = { sessionId: "session", sessions: h.repo, store: { findForProject: async () => [] } as unknown as TaskMdStore, hasPendingQuestion: () => true };
    expect(await checkResidual(input)).toBe("waiting");
    expect(h.events).toHaveLength(0);
    expect(claimHumanResponseConfirmation(h.repo, "session")).toBe(true);
  });

  it("treats unreadable metadata as not waiting instead of throwing at the caller", () => {
    const h = harness();
    h.row.metadata = "{not json";
    // The stalled-session sweep calls this per active session; a throw here would
    // abort the whole pass and starve every later session of its confirmation.
    expect(() => claimHumanResponseConfirmation(h.repo, "session")).not.toThrow();
    expect(isWaitingForHumanResponse(h.repo, "session")).toBe(true);
  });

  it("a no-action residual result does not inject a phase handoff", () => {
    const h = harness();
    const phase = startPhaseCompaction({ sessions: h.repo });
    try {
      eventBus.emit({ type: "taskflow.residual_checked", session_id: "session", outcome: "none", pending_count: 0, ts: 1 });
      expect(h.events).toHaveLength(0);
    } finally { phase.stop(); }
  });
});
