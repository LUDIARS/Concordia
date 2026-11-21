import { describe, expect, it } from "vitest";
import type { Decision, ManagementRequest, Mission, RequestState } from "./domain.js";
import { readMissionStatusSnapshots, type StatusSnapshotRepo } from "./status-snapshot.js";

function mission(id: string, patch: Partial<Mission> = {}): Mission {
  return {
    id, name: `任務 ${id}`, department_id: null, project_codes: ["Cc"], goal: "g", allowed_kinds: ["fix"],
    human_gate_kinds: [], requires_effect_check: false, max_open_requests: 3, daily_request_limit: 10,
    review_interval_minutes: 30, status: "active", token_hash: `h-${id}`, created_at: 0, updated_at: 0, revision: 1, ...patch,
  };
}

function request(missionId: string, state: RequestState): ManagementRequest {
  return { mission_id: missionId, state } as ManagementRequest;
}

function repo(missions: Mission[], requests: ManagementRequest[], decisions: Record<string, Decision[]> = {}): StatusSnapshotRepo {
  return {
    listMissions: () => missions,
    acknowledgedSeq: (id) => (id === "m1" ? 4 : 0),
    pendingSeqs: (projects, after) => (projects.length ? [3, 5, 6, 7].filter((seq) => seq > after) : []),
    recentDecisions: (id, limit) => (decisions[id] ?? []).slice(0, limit),
    listRequestsByStates: (states) => requests.filter((r) => states.includes(r.state)),
  };
}

describe("dots mission status snapshot (spec/feature/control-session.md §11)", () => {
  it("counts pending changes after the acknowledged position and requests per mission", () => {
    const snapshots = readMissionStatusSnapshots(repo(
      [mission("m1"), mission("m2", { status: "stopped", review_interval_minutes: 60 })],
      [
        request("m1", "waiting_human"), request("m1", "launch_failed"), request("m1", "dispatched"),
        request("m1", "queued"), request("m2", "dispatched"), request("m1", "accepted"),
      ],
      { m1: [{ created_at: 1234 } as Decision] },
    ));
    expect(snapshots).toEqual([
      { name: "任務 m1", status: "active", pendingChanges: 3, lastDecisionAt: 1234, waitingHuman: 1, launchFailed: 1, running: 2, reviewIntervalMinutes: 30 },
      { name: "任務 m2", status: "stopped", pendingChanges: 4, lastDecisionAt: null, waitingHuman: 0, launchFailed: 0, running: 1, reviewIntervalMinutes: 60 },
    ]);
  });

  it("returns no rows when there are no missions", () => {
    expect(readMissionStatusSnapshots(repo([], []))).toEqual([]);
  });
});
