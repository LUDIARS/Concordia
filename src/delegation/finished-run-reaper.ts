/**
 * 終了済み run に残ったプロセスの走査と回収 (ゾンビ委託)。
 *
 * 判定そのものは zombie-run-detect.ts の純関数。 ここは 「repo から読む・停止する・
 * ログを出す・定期実行する」 という副作用側だけを持つ。
 *
 * run-watchdog.ts の対になる関心。 あちらは *進行中* の run が止まっていないかを
 * 見て子へ inject する。 こちらは *終わった* run が居座っていないかを見て
 * プロセスだけを対象にする。 run の status は書き換えない。
 *
 * 既定は検出のみ。 kill は共有インフラの lifecycle 操作なので、 明示的に
 * `autoReap` を有効にしたときだけ行う (自己判断で殺さない)。
 */

import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";
import { scanAgentProcesses, type RunningAgentProc } from "../control/agent-process-scan.js";
import { stopSessionByLictorPid, type StopResult } from "../control/stop-session.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";
import { findZombieRuns, type ZombieRun } from "./zombie-run-detect.js";

const log = createChildLogger("delegation-finished-reaper");

/** 既定の走査間隔。 残留は時間単位で居座るため、 頻繁に見る必要はない。 */
export const FINISHED_RUN_SCAN_INTERVAL_MS = 5 * 60_000;

export interface FinishedRunReaperRunsRepo {
  listFinishedRunsWithChildSession(limit?: number): DelegationRunRow[];
}

export interface FinishedRunReaperSessionsRepo {
  findSession(id: string): SessionRow | null;
}

export interface ReapResult {
  zombie: ZombieRun;
  stop: StopResult;
}

export interface ReapZombieRunsInput {
  zombies: ZombieRun[];
  stop?(pid: number): Promise<StopResult>;
}

/** 検出済みの残留プロセスを順に停止する。 taskkill /F /T でプロセスツリーごと落とす。 */
export async function reapZombieRuns(input: ReapZombieRunsInput): Promise<ReapResult[]> {
  const stop = input.stop ?? stopSessionByLictorPid;
  const results: ReapResult[] = [];
  const stoppedPids = new Set<number>();
  for (const zombie of input.zombies) {
    // 同じ child session が複数 run に誤って紐付いていても、同一 PID を二度 kill しない。
    // 1 回目の停止後に PID が再利用される短い race で無関係な process を止めるのを防ぐ。
    if (stoppedPids.has(zombie.lictor_pid)) continue;
    stoppedPids.add(zombie.lictor_pid);
    const result = await stop(zombie.lictor_pid);
    results.push({ zombie, stop: result });
  }
  return results;
}

export interface FinishedRunReaperOptions {
  runs: FinishedRunReaperRunsRepo;
  sessions: FinishedRunReaperSessionsRepo;
  /** 有効/無効は毎 tick live 評価する (設定変更を再起動なしで効かせる)。 */
  resolveEnabled(): boolean;
  /** true なら検出した残留プロセスを停止する。 既定 false = 検出と通知のみ。 */
  resolveAutoReap(): boolean;
  resolveGraceMs?(): number;
  intervalMs?: number;
  nowMs?(): number;
  scanProcesses?(): Promise<RunningAgentProc[]>;
  stop?(pid: number): Promise<StopResult>;
  onZombies?(zombies: ZombieRun[]): void;
}

/**
 * 走査を 1 回だけ回す。 interval から呼ばれるが、 API から手動で叩けるように
 * 公開しておく (「いま掃除して」 に応えられる形)。
 */
export async function scanFinishedRuns(options: FinishedRunReaperOptions): Promise<ZombieRun[]> {
  if (!options.resolveEnabled()) return [];
  const nowMs = (options.nowMs ?? Date.now)();
  const processes = await (options.scanProcesses ?? scanAgentProcesses)();
  const zombies = findZombieRuns({
    runs: options.runs.listFinishedRunsWithChildSession(),
    findSession: (id) => options.sessions.findSession(id),
    processes,
    nowMs,
    graceMs: options.resolveGraceMs?.(),
  });
  if (zombies.length === 0) return [];

  log.warn(
    { count: zombies.length, runs: zombies.map((z) => z.run_id) },
    "finished delegation runs still have a live process",
  );
  options.onZombies?.(zombies);

  if (options.resolveAutoReap()) {
    // 検出と kill の間に session metadata / PID 世代が変わり得る。破壊的操作の直前に
    // authoritative row と process snapshot を取り直し、現在も所有権が一致するものだけ止める。
    const confirmed = findZombieRuns({
      runs: options.runs.listFinishedRunsWithChildSession(),
      findSession: (id) => options.sessions.findSession(id),
      processes: await (options.scanProcesses ?? scanAgentProcesses)(),
      nowMs: (options.nowMs ?? Date.now)(),
      graceMs: options.resolveGraceMs?.(),
    });
    const results = await reapZombieRuns({ zombies: confirmed, stop: options.stop });
    for (const result of results) {
      if (result.stop.ok) {
        log.info({ run_id: result.zombie.run_id, pid: result.zombie.lictor_pid }, "reaped zombie delegation process");
      } else {
        log.error(
          { run_id: result.zombie.run_id, pid: result.zombie.lictor_pid, error: result.stop.error },
          "failed to reap zombie delegation process",
        );
      }
    }
  }
  return zombies;
}

/** 定期走査を開始する。 run-watchdog と同じ bulkhead に乗せる。 */
export function startFinishedRunReaper(options: FinishedRunReaperOptions): SupervisedIntervalHandle {
  return startSupervisedInterval(
    "delegation-finished-run-reaper",
    () => scanFinishedRuns(options),
    { intervalMs: options.intervalMs ?? FINISHED_RUN_SCAN_INTERVAL_MS },
  );
}
