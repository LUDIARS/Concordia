/**
 * lost セッションに残留する Lictor process tree の回収。
 *
 * 汎用 orphan 判定とは分け、DB上の lost rowとOS上の `lictor.mjs` PIDが一致した場合だけ
 * killする。kill直前にrowを再取得し、heartbeat/WS再接続でactiveへ復帰したセッションを
 * 殺さない。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { parseLictorPid } from "./session-process-metadata.js";
import { stopSessionByLictorPid, type StopResult } from "./stop-session.js";

export interface ObservedAgentProcess {
  pid: number;
  kind: "lictor" | "agent-client";
  ageSec: number;
}

export interface LostLictorCandidate {
  sessionId: string;
  pid: number;
  lastSeenAt: number;
  processAgeSec: number;
}

export interface LostLictorReapResult {
  candidates: LostLictorCandidate[];
  killed: LostLictorCandidate[];
  skipped: LostLictorCandidate[];
  failed: Array<{ candidate: LostLictorCandidate; error: string }>;
}

type LostSessionRepo = Pick<SessionsRepo, "listSessions" | "findSession">;
type StopProcess = (pid: number) => Promise<StopResult>;

export interface LostLictorReapDeps {
  repo: LostSessionRepo;
  processes: ObservedAgentProcess[];
  stopProcess?: StopProcess;
}

export interface LostLictorReapOptions {
  dryRun: boolean;
  nowSec: number;
  graceSec: number;
  minProcessAgeSec: number;
}

/** lost猶予を過ぎ、DB metadataとOS cmdlineのPIDが一致するLictorだけを回収する。 */
export async function reapLostLictorProcesses(
  deps: LostLictorReapDeps,
  opts: LostLictorReapOptions,
): Promise<LostLictorReapResult> {
  const processByPid = new Map(
    deps.processes
      .filter((process) => process.kind === "lictor")
      .map((process) => [process.pid, process] as const),
  );
  const protectedPids = collectProtectedPids(deps.repo, opts);
  const candidates = deps.repo
    .listSessions({ status: "lost" })
    .map((session) => candidateFor(session, processByPid, protectedPids, opts))
    .filter((candidate): candidate is LostLictorCandidate => candidate !== null);
  const result: LostLictorReapResult = { candidates, killed: [], skipped: [], failed: [] };
  if (opts.dryRun) return result;

  const stopProcess = deps.stopProcess ?? stopSessionByLictorPid;
  for (const candidate of candidates) {
    // scan後にheartbeat/WS再接続が届く可能性がある。spawn/taskkillを発行する直前に
    // authoritative rowを同期再取得し、active復帰・PID差替え・WS再接続なら見送る。
    const current = deps.repo.findSession(candidate.sessionId);
    const refreshed = current ? candidateFor(current, processByPid, new Set(), opts) : null;
    const nowProtected = collectProtectedPids(deps.repo, opts, candidate.sessionId);
    if (!refreshed || refreshed.pid !== candidate.pid || nowProtected.has(candidate.pid)) {
      result.skipped.push(candidate);
      continue;
    }
    const stopped = await stopProcess(candidate.pid);
    if (stopped.ok) result.killed.push(candidate);
    else result.failed.push({ candidate, error: stopped.error });
  }
  return result;
}

function candidateFor(
  session: Pick<SessionRow, "id" | "status" | "metadata" | "last_seen_at" | "ws_clients">,
  processByPid: ReadonlyMap<number, ObservedAgentProcess>,
  protectedPids: ReadonlySet<number>,
  opts: Pick<LostLictorReapOptions, "nowSec" | "graceSec" | "minProcessAgeSec">,
): LostLictorCandidate | null {
  if (session.status !== "lost" || session.ws_clients > 0) return null;
  const cutoff = lostCutoff(opts.nowSec, opts.graceSec);
  if (cutoff === null || session.last_seen_at > cutoff) return null;
  if (!Number.isFinite(opts.minProcessAgeSec) || opts.minProcessAgeSec < 0) return null;
  const pid = parseLictorPid(session.metadata);
  if (pid === null || protectedPids.has(pid)) return null;
  const process = processByPid.get(pid);
  if (!process || process.ageSec < opts.minProcessAgeSec) return null;
  return { sessionId: session.id, pid, lastSeenAt: session.last_seen_at, processAgeSec: process.ageSec };
}

/** active、または復帰猶予内/WS接続中のlost rowが参照するPIDはPID再利用とみなして保護する。 */
function collectProtectedPids(
  repo: LostSessionRepo,
  opts: Pick<LostLictorReapOptions, "nowSec" | "graceSec">,
  excludeSessionId?: string,
): Set<number> {
  const protectedPids = new Set<number>();
  const addPid = (session: Pick<SessionRow, "id" | "metadata">): void => {
    if (session.id === excludeSessionId) return;
    const pid = parseLictorPid(session.metadata);
    if (pid !== null) protectedPids.add(pid);
  };
  for (const session of repo.listSessions({ status: "active" })) addPid(session);
  const cutoff = lostCutoff(opts.nowSec, opts.graceSec);
  for (const session of repo.listSessions({ status: "lost" })) {
    if (cutoff === null || session.ws_clients > 0 || session.last_seen_at > cutoff) addPid(session);
  }
  return protectedPids;
}

/** destructive cleanupの時刻設定が不正ならfail-safeで回収対象を作らない。 */
function lostCutoff(nowSec: number, graceSec: number): number | null {
  if (!Number.isFinite(nowSec) || !Number.isFinite(graceSec) || graceSec < 0) return null;
  return nowSec - graceSec;
}
