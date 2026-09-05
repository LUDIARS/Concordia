/**
 * 終了済み run にプロセスが残っているかの判定 (純関数)。
 *
 * 2026-09-05 調査: delegation run が completed / failed になって `finished_at` が
 * 入っているのに、 spawn された claude.exe が終了せず 1 コアを 100% で焼き続ける
 * 事象が常態化していた。 6 本が 12〜46 時間残留し、 合わせて約 7.5 コアを消費
 * (24 コア機で Idle 1.4 コアまで飽和)。
 *
 * 判定だけをここに置き、 プロセス停止・ログ・定期実行は finished-run-reaper.ts に
 * 分ける。 タイマーも kill も持ち込まずにテストできる形にしておく。
 */

import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { RunningAgentProc } from "../control/agent-process-scan.js";
import { matchesObservedProcessGeneration, parseLictorPid } from "../control/session-process-metadata.js";

/**
 * finished_at からこの時間が経ってもプロセスが生きていれば残留とみなす。
 * 終了処理 (session-end flow、 transcript flush、 Discord 投稿) には猶予が要る。
 */
export const DEFAULT_ZOMBIE_GRACE_MS = 10 * 60_000;

export interface ZombieRun {
  run_id: string;
  child_session_id: string;
  lictor_pid: number;
  /** run が終了扱いになった時刻 (epoch-ms)。 */
  finished_at: number;
  /** 終了扱いからの経過 (ms)。 */
  lingering_ms: number;
  status: DelegationRunRow["status"];
}

export interface FindZombieRunsInput {
  runs: DelegationRunRow[];
  findSession(id: string): SessionRow | null;
  /** Excubitor で観測した現在の agent process。 PID 単独では所有権の証明にならない。 */
  processes: ReadonlyArray<Pick<RunningAgentProc, "pid" | "kind" | "ageSec">>;
  nowMs: number;
  graceMs?: number;
}

/** 終了済み run のうち、 子プロセスがまだ生きているものを返す。 */
export function findZombieRuns(input: FindZombieRunsInput): ZombieRun[] {
  const graceMs = input.graceMs ?? DEFAULT_ZOMBIE_GRACE_MS;
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(graceMs) || graceMs < 0) return [];
  const processByPid = new Map(
    input.processes
      .filter((process) => process.kind === "lictor")
      .map((process) => [process.pid, process] as const),
  );
  const zombies: ZombieRun[] = [];
  for (const run of input.runs) {
    if (run.status !== "completed" && run.status !== "failed") continue;
    const finishedAt = run.finished_at ?? null;
    const childSessionId = run.child_session_id;
    if (finishedAt === null || !childSessionId) continue;
    const lingeringMs = input.nowMs - finishedAt;
    if (lingeringMs < graceMs) continue;

    const session = input.findSession(childSessionId);
    if (!session) continue;
    const pid = parseLictorPid(session.metadata ?? null);
    if (pid === null) continue;
    const process = processByPid.get(pid);
    if (!process || !matchesObservedProcessGeneration(session.metadata, process.ageSec, input.nowMs / 1000)) continue;

    zombies.push({
      run_id: run.id,
      child_session_id: childSessionId,
      lictor_pid: pid,
      finished_at: finishedAt,
      lingering_ms: lingeringMs,
      status: run.status,
    });
  }
  return zombies;
}
