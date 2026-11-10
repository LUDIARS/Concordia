/**
 * セッション継承 (relictor / handover) のユースケース。
 *
 * 手動 route (`POST /v1/sessions/:id/relictor`, `/:id/handover`) と自動引き継ぎ監視の
 * 両方がここを呼ぶ。 機構を 1 か所に保ち、 route は HTTP 変換だけを担う。
 *
 * 流れ: 前提検査 → 重複実行の拒否 → handoff 作成 → チャンネル投稿 → spawn ID で
 * 引き継ぎ登録 → 後継 spawn (失敗時は登録を破棄) → 旧セッションを ended + force-exit。
 * I/O はすべて ports 経由で、 本ファイルは順序と不変条件だけを持つ。
 *
 * @implements spec/feature/session-auto-succession.md §1.2 (CC-AUTO-SUCC-01)
 */

import type { SessionRow } from "../../shared/types.js";
import type { Goal } from "../goal.js";
import type { PendingRelictorKind } from "../pending-relictor.js";
import type { SpawnProvider, SpawnRequest, SpawnResult } from "../spawner.js";

export type SuccessionKind = Extract<PendingRelictorKind, "relictor" | "handover">;

export type SuccessionResult =
  | { ok: true; spawnCommand: string[] }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export interface HandoverOptions {
  /** 自動起動の表記 (例 "ctx 82%")。 指定時はチャンネル見出しに自動であることを示す。 */
  autoLabel?: string;
}

export interface SessionSuccessionPorts {
  sessions: {
    findSession(id: string): SessionRow | null;
    setStatus(id: string, status: "ended", ts: number, endedAt: number): void;
    appendEvent(input: { session_id: string; ts: number; kind: string; payload: object }): void;
  };
  toSpawnProvider(provider: string): SpawnProvider | null;
  /** force-exit 先の Lictor port。 Lictor ラップでなければ error。 */
  resolveLictorPort(sessionId: string): { port: number } | { error: string };
  /** 旧セッション自身に handoff を書かせる (捕捉失敗時のフォールバックも含む)。 */
  authorHandoffBySession(session: SessionRow): Promise<string>;
  /** 切り離し生成の handoff (relictor 用)。 */
  generateDetachedHandoff(session: SessionRow): Promise<string>;
  postHandoff(sessionId: string, markdown: string): Promise<unknown>;
  readGoal(metadata: string | null): Goal | null;
  recordPendingSuccession(input: { cwd: string; spawnId: string; handoff: string; goal: Goal | null; kind: SuccessionKind }): void;
  forgetPendingSuccession(spawnId: string): void;
  spawn(request: SpawnRequest): Promise<SpawnResult>;
  /** session.ended の通知 (eventBus)。 */
  emitEnded(sessionId: string, ts: number): void;
  /** 旧 Lictor へ force-exit を送る。 best-effort。 */
  forceExit(lictorPort: number): Promise<void>;
  /** force-exit 不発に備えた猶予後の確定 kill の予約。 */
  scheduleInsuranceKill(session: SessionRow, kind: SuccessionKind): void;
  newSpawnId(): string;
  /** epoch 秒。 */
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

export interface SessionSuccessionService {
  relictor(sessionId: string): Promise<SuccessionResult>;
  handover(sessionId: string, options?: HandoverOptions): Promise<SuccessionResult>;
  isInProgress(sessionId: string): boolean;
}

type CheckedTarget = { session: SessionRow; spawnProvider: SpawnProvider; lictorPort: number };

const RELICTOR_HEADING = "🔁 **再起動引き継ぎ資料 (relictor)**";
const HANDOVER_HEADING = "🤝 **次セッション引き継ぎ資料 (handover)**";

/** チャンネル投稿の見出し。 自動起動なら契機を併記する。 */
export function handoverHeading(options?: HandoverOptions): string {
  const label = options?.autoLabel?.trim();
  return label ? `🤝 **次セッション引き継ぎ資料 (自動: ${label})**` : HANDOVER_HEADING;
}

export function createSessionSuccessionService(ports: SessionSuccessionPorts): SessionSuccessionService {
  // 同一セッションの継承を並行に走らせない (二重 spawn 防止)。 プロセス内の排他で十分:
  // 継承は単一 Concordia プロセスの route / 監視からしか起動しない。
  const inProgress = new Set<string>();

  const checkTarget = (sessionId: string): CheckedTarget | Extract<SuccessionResult, { ok: false }> => {
    const session = ports.sessions.findSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "not_found" };
    if (session.status !== "active") return { ok: false, status: 400, error: `session is ${session.status}` };
    const spawnProvider = ports.toSpawnProvider(session.provider);
    if (!spawnProvider) return { ok: false, status: 400, error: `provider ${session.provider} is not spawnable` };
    // lictor_port が無いと旧セッションを確実に畳めないので拒否する。
    const target = ports.resolveLictorPort(sessionId);
    if ("error" in target) return { ok: false, status: 400, error: `not lictor-wrapped: ${target.error}` };
    return { session, spawnProvider, lictorPort: target.port };
  };

  const spawnSuccessorAndEnd = async (
    target: CheckedTarget,
    handoff: string,
    kind: SuccessionKind,
  ): Promise<SuccessionResult> => {
    const { session } = target;
    const spawnId = ports.newSpawnId();
    // SessionStart は enrollment ID で claim する。cwd だけでは並行 spawn を区別できない。
    ports.recordPendingSuccession({
      cwd: session.repo_path, spawnId, handoff, goal: ports.readGoal(session.metadata), kind,
    });
    const result = await ports.spawn({
      provider: target.spawnProvider,
      cwd: session.repo_path,
      mode: "tab",
      title: session.current_task ?? undefined,
      spawnId,
    });
    if (!result.ok) {
      // 後続の別セッションへ handoff が誤投入されないよう破棄する。
      ports.forgetPendingSuccession(spawnId);
      return { ok: false, status: 500, error: `spawn failed: ${result.error}` };
    }
    // 移行なので runSessionEndFlow は回さず軽量に畳む。
    const now = ports.now();
    ports.sessions.setStatus(session.id, "ended", now, now);
    ports.sessions.appendEvent({
      session_id: session.id, ts: now, kind: "end",
      payload: { reason: kind, duration_sec: now - session.started_at },
    });
    ports.emitEnded(session.id, now);
    void ports.forceExit(target.lictorPort).catch(() => {
      // 旧 Lictor が先に終了して接続が切れることがある。保険 kill が後段で確認するため best-effort。
    });
    ports.scheduleInsuranceKill(session, kind);
    ports.log.info(`${kind}: spawned successor + ended old session=${session.id} repo=${session.repo_path}`);
    return { ok: true, spawnCommand: result.command };
  };

  const postBestEffort = async (sessionId: string, markdown: string, kind: SuccessionKind): Promise<void> => {
    try {
      await ports.postHandoff(sessionId, markdown);
    } catch (error) {
      // 投稿は durable ログの写しで、 移行自体は handoff を pending に持って続行できる。
      ports.log.warn(`${kind}: handoff post failed session=${sessionId}: ${(error as Error).message}`);
    }
  };

  const runExclusive = async (
    sessionId: string,
    kind: SuccessionKind,
    makeHandoff: (session: SessionRow) => Promise<string>,
    heading: string,
  ): Promise<SuccessionResult> => {
    const checked = checkTarget(sessionId);
    if ("ok" in checked) return checked;
    if (inProgress.has(sessionId)) return { ok: false, status: 409, error: "session succession already in progress" };
    inProgress.add(sessionId);
    try {
      const handoff = await makeHandoff(checked.session);
      await postBestEffort(sessionId, `${heading}\n\n${handoff}`, kind);
      return await spawnSuccessorAndEnd(checked, handoff, kind);
    } finally {
      inProgress.delete(sessionId);
    }
  };

  return {
    relictor: (sessionId) =>
      runExclusive(sessionId, "relictor", (session) => ports.generateDetachedHandoff(session), RELICTOR_HEADING),
    handover: (sessionId, options) =>
      runExclusive(sessionId, "handover", (session) => ports.authorHandoffBySession(session), handoverHeading(options)),
    isInProgress: (sessionId) => inProgress.has(sessionId),
  };
}
