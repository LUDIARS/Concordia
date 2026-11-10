/**
 * 自動引き継ぎ・リポ担当の監視。 一定間隔で active セッションを走査し、 判定 → 記録 → 実行する。
 *
 * - 自動引き継ぎ: decideContextHandover が handover を返したら、 spawn 枠を取り、
 *   metadata に試行を記録してから SessionSuccessionService.handover を呼ぶ (INV-1: 記録先行)。
 * - リポ担当: 走査ごとに RepoAgentService.sweep (時間切れ・保留 spawn・副契機) を呼ぶ。
 *
 * 前の走査が終わっていなければ次の走査は飛ばす (handover の自筆捕捉は数分かかりうる)。
 *
 * @implements spec/feature/session-auto-succession.md §2.2, §3.1 02b (CC-AUTO-SUCC-01, INV-1, INV-3, INV-4)
 */

import type { SessionRow } from "../../shared/types.js";
import { autoHandoverRecordPatch, readAutoHandoverRecord } from "./auto-handover-metadata.js";
import { decideContextHandover, describeHandoverMeasure, type ContextHandoverInput } from "./context-handover-policy.js";
import { isDelegatedSession, parseSessionMetadata } from "./managed-session.js";
import type { RepoAgentService } from "./repo-agent-service.js";
import type { SessionSuccessionService } from "./session-succession-service.js";
import { isSessionIdle, type LastTranscriptFrame } from "./session-idle.js";
import type { SpawnBudget } from "./spawn-budget.js";
import type { SuccessionSettings } from "./succession-settings.js";

export const DEFAULT_WATCH_INTERVAL_MS = 120_000;

export interface AutoSuccessionWatcherPorts {
  listActiveSessions(): SessionRow[];
  /** 観測した占有トークン。 観測できなければ null。 */
  readContextTokens(session: SessionRow): Promise<number | null>;
  lastFrame(sessionId: string): LastTranscriptFrame | null;
  /** 人間の返事待ち (質問カード・human-wait・確認待ち・ask マーカー)。 awaiting-human.ts。 */
  isAwaitingHuman(session: SessionRow): Promise<boolean>;
  isSessionEnding(metadataJson: string | null): boolean;
  recordAttempt(sessionId: string, patch: Record<string, unknown>): void;
  succession: Pick<SessionSuccessionService, "handover" | "isInProgress">;
  repoAgents: Pick<RepoAgentService, "sweep">;
  spawnBudget: SpawnBudget;
  settings(): SuccessionSettings;
  /** epoch 秒。 */
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

export interface AutoSuccessionWatcher {
  /** 1 走査。 前の走査が進行中なら何もしない。 */
  tick(): Promise<void>;
}

export interface AutoSuccessionWatcherHandle {
  stop(): void;
}

export function createAutoSuccessionWatcher(ports: AutoSuccessionWatcherPorts): AutoSuccessionWatcher {
  let running = false;

  const handoverInput = (
    session: SessionRow,
    idle: boolean,
    tokens: number | null,
    awaitingHuman: boolean,
  ): ContextHandoverInput => {
    const metadata = parseSessionMetadata(session.metadata);
    return {
      status: session.status,
      provider: session.provider,
      managedElsewhere: isDelegatedSession(metadata),
      tokens,
      sessionEnding: ports.isSessionEnding(session.metadata),
      awaitingHuman,
      idle,
      alreadyAttempted: readAutoHandoverRecord(metadata) !== null,
    };
  };

  const maybeHandover = async (session: SessionRow, idle: boolean, settings: SuccessionSettings): Promise<void> => {
    if (ports.succession.isInProgress(session.id)) return;
    // 安い条件 (provider・試行済み等) で落ちるセッションの占有は読まない。
    const precheck = decideContextHandover(handoverInput(session, idle, null, false), settings.handover);
    if (precheck.action === "skip" && precheck.reason !== "unknown_usage") return;
    const tokens = await ports.readContextTokens(session);
    // 返事待ちの判定は transcript 末尾を読むので、 他の条件をすべて満たしたセッションだけで行う。
    const measured = decideContextHandover(handoverInput(session, idle, tokens, false), settings.handover);
    if (measured.action === "skip") return;
    const awaitingHuman = await ports.isAwaitingHuman(session);
    const decision = decideContextHandover(handoverInput(session, idle, tokens, awaitingHuman), settings.handover);
    if (decision.action === "skip") return;
    // 上限超過は記録せず次の走査へ回す (記録すると 1 回きりの試行を使い切ってしまう)。
    if (!ports.spawnBudget.tryTake()) {
      ports.log.info(`auto-handover: spawn 上限のため次の走査へ session=${session.id}`);
      return;
    }
    ports.recordAttempt(session.id, autoHandoverRecordPatch({ attempted_at: ports.now(), measure: decision.measure }));
    const label = describeHandoverMeasure(decision.measure);
    ports.log.info(`auto-handover: 開始 session=${session.id} ${label} tokens=${decision.measure.tokens}`);
    const result = await ports.succession.handover(session.id, { autoLabel: label });
    if (result.ok) ports.log.info(`auto-handover: 完了 session=${session.id}`);
    else ports.log.warn(`auto-handover: 失敗 session=${session.id} status=${result.status} error=${result.error} (再送しない)`);
  };

  const visit = async (session: SessionRow, settings: SuccessionSettings): Promise<void> => {
    const idle = isSessionIdle(ports.lastFrame(session.id), ports.now(), settings.quietSec);
    await ports.repoAgents.sweep(session, idle);
    await maybeHandover(session, idle, settings);
  };

  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        const settings = ports.settings();
        for (const session of ports.listActiveSessions()) {
          try {
            await visit(session, settings);
          } catch (error) {
            // 1 セッションの失敗で他のセッションの走査を止めない。
            ports.log.warn(`auto-succession: 走査失敗 session=${session.id}: ${(error as Error).message}`);
          }
        }
      } finally {
        running = false;
      }
    },
  };
}

/** 一定間隔で tick する。 timer はプロセス終了を妨げない (unref)。 */
export function startAutoSuccessionWatcher(
  watcher: AutoSuccessionWatcher,
  intervalMs: number,
  log: { warn(message: string): void },
): AutoSuccessionWatcherHandle {
  const timer = setInterval(() => {
    watcher.tick().catch((error: unknown) => {
      log.warn(`auto-succession: tick failed: ${(error as Error).message}`);
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
