/** @implements spec/feature/periodic-progress-report.md */
import { describe, expect, it } from "vitest";
import { eventBus, type ConcordiaEvent } from "../events.js";
import type { SessionRow } from "../shared/types.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { startStalledSessionNudge } from "./stalled-session-nudge.js";
import { claimNudgeDelivery } from "./nudge-delivery.js";

function fixture(metadata: Record<string, unknown> = {}) {
  const row = { id: "worker", status: "active", provider: "codex-cli", repo_path: "/repo",
    repo_origin: "origin", branch: "feat/progress", current_task: "implement", target_project: "/repo",
    metadata: JSON.stringify(metadata), transcript_path: null, ws_clients: 1,
    host: "test", started_at: 0, ended_at: null, last_seen_at: 0 } as SessionRow;
  const repo = {
    findAllActive: () => [{ ...row }], findSession: () => row,
    updateMetadata: (_id: string, update: (value: Record<string, unknown>) => Record<string, unknown>) => {
      row.metadata = JSON.stringify(update(JSON.parse(row.metadata ?? "{}")));
    },
  } as unknown as SessionsRepo;
  return { row, repo };
}

describe("progress through the existing ten-minute tick", () => {
  it("requests a report while active, combines idle requests, persists a shared watchdog slot", async () => {
    const { row, repo } = fixture();
    let at = 1_000_000;
    let activity = at - 1;
    const events: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));
    const options = { repo, activeDelegationRunId: () => "run", now: () => at,
      lastActivityMs: () => activity, readTranscriptTail: async () => null };
    let handle = startStalledSessionNudge(options);
    try {
      expect(await handle.runOnce()).toEqual([row.id]);
      expect(events.filter((e) => e.type === "session.inject")).toHaveLength(1);
      expect(events.some((e) => e.type === "session.stall_nudged")).toBe(false);
      expect(claimNudgeDelivery(repo, row.id, ++activity, at, 600_000)).toBe(false);
      handle.stop();
      handle = startStalledSessionNudge(options); // Restart preserves contact suppression.
      expect(await handle.runOnce()).toEqual([]);
      at += 600_000;
      activity = at - 1;
      expect(await handle.runOnce()).toEqual([row.id]);
      at += 600_000;
      // No new activity since the last request: don't stack unanswered messages.
      expect(await handle.runOnce()).toEqual([]);
    } finally { handle.stop(); unsubscribe(); }
  });
  it("does not send a second report when watchdog claimed the contact first", async () => {
    const { row, repo } = fixture();
    expect(claimNudgeDelivery(repo, row.id, 900_000, 1_000_000, 600_000)).toBe(true);
    const handle = startStalledSessionNudge({ repo, activeDelegationRunId: () => "run", now: () => 1_000_001,
      lastActivityMs: () => 1_000_000, readTranscriptTail: async () => null });
    try { expect(await handle.runOnce()).toEqual([]); } finally { handle.stop(); }
  });
  it("keeps ordinary active sessions out of the reporting scope", async () => {
    const { repo } = fixture();
    const handle = startStalledSessionNudge({ repo, now: () => 1_000_000,
      lastActivityMs: () => 999_999, readTranscriptTail: async () => null });
    try { expect(await handle.runOnce()).toEqual([]); } finally { handle.stop(); }
  });
  it.each(["question", "ask", "gate", "binding", "scope", "human", "off", "strikes"])("preserves %s before sending", async (blocker) => {
    const { row, repo } = fixture(blocker === "off" ? { goal_and_go: false }
      : blocker === "strikes" ? { cc_auto_confirm_strikes: 3 }
      : blocker === "human" ? { cc_human_wait: { active: true, summary: "approval", task_references: [], since: 1 } } : {});
    let run = "run";
    const removeGate = eventBus.registerInjectGate(() => blocker !== "gate");
    const handle = startStalledSessionNudge({ repo, activeDelegationRunId: () => run,
      now: () => 1_000_000, lastActivityMs: () => 999_999,
      hasPendingQuestion: () => blocker === "question",
      readTranscriptTail: async () => {
        if (blocker === "binding") row.branch = "other";
        if (blocker === "scope") run = "different-run";
        return blocker === "ask" ? '```ask\n{}\n```' : null;
      } });
    try {
      expect(await handle.runOnce()).toEqual([]);
      expect(JSON.parse(row.metadata ?? "{}").cc_nudge_delivery).toBeUndefined();
    } finally { handle.stop(); removeGate(); }
  });
});
