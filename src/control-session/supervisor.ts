/**
 * 管制の巡回。1 周ごとに singleton の起動・復旧、退役世代への終了案内、進捗ボードの上書き、
 * 停止の要約の送信を行う。OFF なら管制セッションへ終了を促して保持者を消す。
 *
 * @implements spec/feature/control-session.md — 1. singleton / 2. 進捗ボード / 4. 追加指示 / 6. ON / OFF / CC-CTL-INV-01 / CC-CTL-INV-02 / CC-CTL-INV-04
 */
import type { SessionRow } from "../shared/types.js";
import type { ControlBoardRepo } from "./board-repo.js";
import { projectBoardEntry } from "./board-projection.js";
import { nextControlHolder, type ControlHolderStore } from "./holder-store.js";
import { checkInstructionEligibility, type EligibilityProbes } from "./instruction-eligibility.js";
import { decideControlSingleton, spawnIdOf } from "./singleton-policy.js";
import { CONTROL_DIGEST_LIMIT, renderStallDigest, selectStalledRows } from "./stall-digest.js";

export const CONTROL_SUPERVISOR_SOURCE = "auto:control-supervisor";
export const CONTROL_RETIRE_NOTICE = "[管制] 管制セッションは別の世代へ交代したか OFF になりました。作業を終えて、このセッションを終了してください。";

export interface ControlSupervisorDeps {
  isEnabled(): boolean;
  sessions: { findAllActive(): SessionRow[] };
  holders: ControlHolderStore;
  board: ControlBoardRepo;
  projectOf(session: SessionRow): string;
  latestStat(sessionId: string): { ts: number; payload: string } | null;
  lastActivitySec(sessionId: string): number | null;
  /** 管制セッションを起動する。spawnId は保持者へ先に記録済み。 */
  spawnControl(input: { spawnId: string; generation: number }): Promise<{ ok: true } | { ok: false; error: string }>;
  newSpawnId(): string;
  /** 管制セッションへの案内・要約。届けられなければ false。 */
  injectToControl(sessionId: string, text: string): boolean;
  probes: EligibilityProbes;
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

export interface ControlTickReport {
  enabled: boolean;
  controlSessionId: string | null;
  spawned: boolean;
  boardRows: number;
  digested: string[];
}

export function createControlSupervisor(deps: ControlSupervisorDeps) {
  function liveBySpawnId(active: readonly SessionRow[], spawnId: string): SessionRow | null {
    return active.find((s) => spawnIdOf(s.metadata) === spawnId) ?? null;
  }

  /** いまの保持者 (と退役世代) の spawn ID で動いているセッションか。 */
  function isControlSession(session: Pick<SessionRow, "metadata">): boolean {
    const spawnId = spawnIdOf(session.metadata);
    if (!spawnId) return false;
    const holder = deps.holders.read();
    return !!holder && (holder.spawn_id === spawnId || holder.retired.some((r) => r.spawn_id === spawnId));
  }

  function currentControlSessionId(): string | null {
    const holder = deps.holders.read();
    return holder ? liveBySpawnId(deps.sessions.findAllActive(), holder.spawn_id)?.id ?? null : null;
  }

  function retire(active: readonly SessionRow[]): void {
    const holder = deps.holders.read();
    if (!holder) return;
    const live = liveBySpawnId(active, holder.spawn_id);
    if (live) deps.injectToControl(live.id, CONTROL_RETIRE_NOTICE);
    deps.holders.clear();
    deps.board.clear();
    deps.log.info("control session disabled: holder cleared");
  }

  async function ensureSingleton(active: readonly SessionRow[], nowMs: number): Promise<{ id: string | null; spawned: boolean }> {
    const holder = deps.holders.read();
    const live = holder ? liveBySpawnId(active, holder.spawn_id) : null;
    const decision = decideControlSingleton({ holder, liveSessionId: live?.id ?? null, nowMs });
    if (decision.action === "keep") return { id: decision.sessionId, spawned: false };
    if (decision.action === "wait") return { id: null, spawned: false };
    // 起動の意図を先に記録する。起動の途中で落ちても猶予内に重ねて起動しない。
    const next = nextControlHolder(holder, deps.newSpawnId(), nowMs);
    deps.holders.write(next);
    const result = await deps.spawnControl({ spawnId: next.spawn_id, generation: next.generation });
    if (result.ok) deps.log.info(`control session spawned generation=${next.generation} reason=${decision.reason}`);
    else deps.log.warn(`control session spawn failed generation=${next.generation}: ${result.error}`);
    return { id: null, spawned: result.ok };
  }

  function notifyRetired(active: readonly SessionRow[]): void {
    const holder = deps.holders.read();
    for (const retired of holder?.retired ?? []) {
      if (retired.notified) continue;
      const live = liveBySpawnId(active, retired.spawn_id);
      if (live && deps.injectToControl(live.id, CONTROL_RETIRE_NOTICE)) deps.holders.markRetiredNotified(retired.spawn_id);
    }
  }

  function refreshBoard(active: readonly SessionRow[], nowMs: number): number {
    const targets = active.filter((s) => !isControlSession(s));
    const nowSec = Math.floor(nowMs / 1000);
    for (const session of targets) {
      deps.board.upsert(projectBoardEntry({
        session, project: deps.projectOf(session), sideStat: deps.latestStat(session.id),
        lastActivitySec: deps.lastActivitySec(session.id), nowSec,
      }));
    }
    deps.board.retainOnly(targets.map((s) => s.id));
    return targets.length;
  }

  async function sendDigest(controlId: string, active: readonly SessionRow[]): Promise<string[]> {
    const byId = new Map(active.map((s) => [s.id, s]));
    const eligible = [];
    for (const row of selectStalledRows(deps.board.list())) {
      if (eligible.length >= CONTROL_DIGEST_LIMIT) break;
      const check = await checkInstructionEligibility(byId.get(row.session_id) ?? null, deps.probes);
      if (check.ok) eligible.push(row);
    }
    if (!eligible.length) return [];
    if (!deps.injectToControl(controlId, renderStallDigest(eligible))) return [];
    for (const row of eligible) deps.board.markDigested(row.session_id, row.fingerprint!);
    return eligible.map((row) => row.session_id);
  }

  async function runOnce(): Promise<ControlTickReport> {
    const active = deps.sessions.findAllActive();
    if (!deps.isEnabled()) {
      retire(active);
      return { enabled: false, controlSessionId: null, spawned: false, boardRows: 0, digested: [] };
    }
    const nowMs = deps.now();
    const singleton = await ensureSingleton(active, nowMs);
    notifyRetired(active);
    const boardRows = refreshBoard(active, nowMs);
    const digested = singleton.id ? await sendDigest(singleton.id, active) : [];
    return { enabled: true, controlSessionId: singleton.id, spawned: singleton.spawned, boardRows, digested };
  }

  return { runOnce, isControlSession, currentControlSessionId };
}

export type ControlSupervisor = ReturnType<typeof createControlSupervisor>;
