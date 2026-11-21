/**
 * 管制まとめ向けに、任務ごとの dots 連携状況を読む (読み取りだけ)。
 * 表示は control-session 側 (src/control-session/dots-status.ts) が決める。
 *
 * @implements spec/feature/control-session.md §11
 */
import { ACTIVE_STATES, type Decision, type ManagementRequest, type Mission, type RequestState } from "./domain.js";

/** 状況の読み取りに使う repository の口。 */
export interface StatusSnapshotRepo {
  listMissions(): Mission[];
  acknowledgedSeq(missionId: string): number;
  pendingSeqs(projects: readonly string[], afterSeq: number, uptoSeq: number): number[];
  recentDecisions(missionId: string, limit: number): Decision[];
  listRequestsByStates(states: readonly RequestState[], limit: number): ManagementRequest[];
}

export interface MissionStatusSnapshot {
  name: string;
  status: Mission["status"];
  pendingChanges: number;
  lastDecisionAt: number | null;
  waitingHuman: number;
  launchFailed: number;
  running: number;
  reviewIntervalMinutes: number;
}

const COUNTED_STATES: readonly RequestState[] = ["waiting_human", "launch_failed", ...ACTIVE_STATES];
const REQUEST_SCAN_LIMIT = 1_000;

export function readMissionStatusSnapshots(repo: StatusSnapshotRepo): MissionStatusSnapshot[] {
  const requests = repo.listRequestsByStates(COUNTED_STATES, REQUEST_SCAN_LIMIT);
  return repo.listMissions().map((mission) => {
    const own = requests.filter((r) => r.mission_id === mission.id);
    const count = (states: readonly RequestState[]) => own.filter((r) => states.includes(r.state)).length;
    return {
      name: mission.name,
      status: mission.status,
      pendingChanges: repo.pendingSeqs(mission.project_codes, repo.acknowledgedSeq(mission.id), Number.MAX_SAFE_INTEGER).length,
      lastDecisionAt: repo.recentDecisions(mission.id, 1)[0]?.created_at ?? null,
      waitingHuman: count(["waiting_human"]),
      launchFailed: count(["launch_failed"]),
      running: count(ACTIVE_STATES),
      reviewIntervalMinutes: mission.review_interval_minutes,
    };
  });
}
