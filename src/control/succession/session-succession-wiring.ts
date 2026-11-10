/**
 * SessionSuccessionService の既定配線 (実 I/O を ports へ結ぶ adapter)。
 *
 * route と自動引き継ぎ監視が同じインスタンスを共有できるよう、 組み立てをここに置く。
 * 上位層 (api / rules) に依存する値 (toSpawnProvider / runClaude / 猶予時間) は引数で受け取り、
 * control 層から上位層を import しない。
 *
 * @implements spec/feature/session-auto-succession.md §1.2
 */

import { randomUUID } from "node:crypto";
import type { ChatRepo } from "../../db/chat-repo.js";
import type { ControlJobsRepo } from "../../db/control-jobs-repo.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { TranscriptLogsRepo } from "../../db/transcript-logs-repo.js";
import { eventBus } from "../../events.js";
import type { SessionRow } from "../../shared/types.js";
import {
  collectRecentContext,
  elicitHandoffFromSession,
  generateHandoff,
  makeCompactionIO,
  type RunClaudeFn,
} from "../compaction.js";
import { readGoalFromMetadata } from "../goal.js";
import { fetchFromLictor, resolveLictorTarget } from "../lictor-proxy.js";
import { forgetPendingRelictorBySpawnId, recordPendingRelictor } from "../pending-relictor.js";
import { parseLictorPid } from "../session-process-metadata.js";
import { spawnSession, type SpawnProvider } from "../spawner.js";
import { isPidAlive } from "../stop-session.js";
import { authorHandoffBySession } from "./session-handoff-author.js";
import {
  createSessionSuccessionService,
  type SessionSuccessionService,
  type SuccessionKind,
} from "./session-succession-service.js";

export interface SessionSuccessionWiringDeps {
  sessions: SessionsRepo;
  chat: ChatRepo;
  transcriptLogs: TranscriptLogsRepo;
  controlJobs: Pick<ControlJobsRepo, "enqueueStopProcess">;
  runClaude: RunClaudeFn;
  toSpawnProvider(provider: string): SpawnProvider | null;
  /** force-exit 後、 Lictor が生き残っていたら確定 kill するまでの猶予。 */
  forceExitGraceMs: number;
  log: { info(message: string): void; warn(message: string): void };
}

export function wireSessionSuccessionService(deps: SessionSuccessionWiringDeps): SessionSuccessionService {
  const io = makeCompactionIO({ sessions: deps.sessions, chat: deps.chat });
  const generateDetached = (session: SessionRow): Promise<string> =>
    generateHandoff({ runClaude: deps.runClaude, log: deps.log }, session.current_task ?? "",
      collectRecentContext(deps.transcriptLogs, session.id));

  const scheduleInsuranceKill = (session: SessionRow, kind: SuccessionKind): void => {
    // force-exit は Windows/ConPTY で不発になりやすい。 猶予後に生存していれば確定 kill。
    const lictorPid = parseLictorPid(session.metadata);
    if (lictorPid == null) return;
    setTimeout(() => {
      if (!isPidAlive(lictorPid)) return;
      try {
        const job = deps.controlJobs.enqueueStopProcess({
          pid: lictorPid, source: `${kind}-insurance`, sessionId: session.id, role: "lictor", expectedCommand: null,
        });
        deps.log.info(`${kind} insurance kill queued session=${session.id} pid=${lictorPid} job=${job.id}`);
      } catch (error) {
        deps.log.warn(`${kind} insurance kill enqueue failed session=${session.id} pid=${lictorPid}: ${(error as Error).message}`);
      }
    }, deps.forceExitGraceMs).unref?.();
  };

  return createSessionSuccessionService({
    sessions: deps.sessions,
    toSpawnProvider: deps.toSpawnProvider,
    resolveLictorPort: (sessionId) => {
      const target = resolveLictorTarget(deps.sessions, sessionId);
      return "error" in target ? target : { port: target.port };
    },
    authorHandoffBySession: (session) => authorHandoffBySession({
      transcriptMaxId: (id) => deps.transcriptLogs.maxId(id),
      inject: io.inject,
      elicit: (id, watermark) => elicitHandoffFromSession({ transcriptLogs: deps.transcriptLogs, log: deps.log }, id, watermark),
      generateDetached,
      log: deps.log,
    }, session),
    generateDetachedHandoff: generateDetached,
    postHandoff: io.postHandoff,
    readGoal: (metadata) => readGoalFromMetadata(metadata),
    recordPendingSuccession: (input) => recordPendingRelictor(input),
    forgetPendingSuccession: (spawnId) => forgetPendingRelictorBySpawnId(spawnId),
    spawn: (request) => spawnSession(request),
    emitEnded: (sessionId, ts) => eventBus.emit({ type: "session.ended", session_id: sessionId, ts }),
    forceExit: async (port) => {
      await fetchFromLictor(port, "/v1/internal/force-exit", { method: "POST" });
    },
    scheduleInsuranceKill,
    newSpawnId: () => randomUUID(),
    now: () => Math.floor(Date.now() / 1000),
    log: deps.log,
  });
}
