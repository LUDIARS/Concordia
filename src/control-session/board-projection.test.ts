import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { fingerprintState, projectBoardEntry, summarizeSidePayload } from "./board-projection.js";

function session(patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s1", provider: "claude-code", repo_path: "E:/r", repo_origin: null, branch: "feat/x", host: "h",
    started_at: 1, ended_at: null, status: "active", last_seen_at: 1, current_task: null, transcript_path: null,
    metadata: null, ws_clients: 1, target_project: null, ...patch,
  } as SessionRow;
}

describe("board projection", () => {
  it("copies the followup state and unchanged count recorded by the auto check", () => {
    const fingerprint = JSON.stringify({ state: "review-wait", workflow: "revisor" });
    const row = projectBoardEntry({
      session: session({
        current_task: "  long   task  ",
        metadata: JSON.stringify({ cc_followup_progress: { fingerprint, unchanged_count: 2, last_checked_at: 1, last_changed_at: 1 } }),
      }),
      project: "Cc", sideStat: { ts: 50, payload: JSON.stringify({ recent_work: "spec 整理", note: "審査待ち" }) },
      lastActivitySec: 40, nowSec: 60,
    });
    expect(row).toMatchObject({
      session_id: "s1", project: "Cc", branch: "feat/x", followup_state: "review-wait", fingerprint,
      unchanged_count: 2, current_task: "long task", side_summary: "spec 整理 / 審査待ち", side_reported_at: 50,
      last_activity_at: 40, updated_at: 60,
    });
  });

  it("leaves the state unknown when the auto check has not recorded anything", () => {
    const row = projectBoardEntry({ session: session(), project: "Cc", sideStat: null, lastActivitySec: null, nowSec: 1 });
    expect(row).toMatchObject({ followup_state: null, fingerprint: null, unchanged_count: 0, side_summary: null });
  });

  it("summarizes nested stat payloads and falls back to raw text", () => {
    expect(summarizeSidePayload(JSON.stringify({ payload: { todos_summary: "残り 2 件" } }))).toBe("残り 2 件");
    expect(summarizeSidePayload(JSON.stringify({ other: 1 }))).toBe('{"other":1}');
    expect(summarizeSidePayload("plain")).toBe("plain");
    expect(summarizeSidePayload("x".repeat(500))?.length).toBe(240);
    expect(fingerprintState("broken")).toBeNull();
  });
});
