/**
 * 自動引き継ぎ・リポ担当の実行時配線 (bootstrap から呼ぶ composition)。
 *
 * SessionSuccessionService / RepoAgentService / AutoSuccessionWatcher を実 I/O の port で組み、
 * route と監視が同じインスタンスを共有できるようにする。 上位層 (api / cost / rules) の値は
 * 引数で受け取り、 control 層から上位層を import しない。
 *
 * @implements spec/feature/session-auto-succession.md §2.2, §3.4, §4.2
 */

import { randomUUID } from "node:crypto";
import type { ChatRepo } from "../../db/chat-repo.js";
import type { ControlJobsRepo } from "../../db/control-jobs-repo.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { TranscriptLogsRepo } from "../../db/transcript-logs-repo.js";
import { eventBus } from "../../events.js";
import type { SessionRow } from "../../shared/types.js";
import type { RunClaudeFn } from "../compaction.js";
import { forgetPendingRelictorBySpawnId, recordPendingRelictor } from "../pending-relictor.js";
import { isSessionEndPending } from "../session-end-process.js";
import { spawnSession, type SpawnProvider } from "../spawner.js";
import {
  createAutoSuccessionWatcher,
  DEFAULT_WATCH_INTERVAL_MS,
  startAutoSuccessionWatcher,
  type AutoSuccessionWatcherHandle,
} from "./auto-succession-watcher.js";
import { createRepoAgentService, type RepoAgentService } from "./repo-agent-service.js";
import type { SessionSuccessionService } from "./session-succession-service.js";
import { wireSessionSuccessionService } from "./session-succession-wiring.js";
import { createSpawnBudget } from "./spawn-budget.js";
import { readSuccessionSettings } from "./succession-settings.js";

/** 子の終了通知で抜粋を探す transcript の末尾行数。 */
const LAST_MESSAGE_SCAN_FRAMES = 50;
/** 1 走査で見る active セッションの上限 (listSessions の上限と同じ)。 */
const MAX_SCANNED_SESSIONS = 500;

export interface SuccessionRuntimeDeps {
  sessions: SessionsRepo;
  chat: ChatRepo;
  transcriptLogs: TranscriptLogsRepo;
  controlJobs: Pick<ControlJobsRepo, "enqueueStopProcess">;
  runClaude: RunClaudeFn;
  toSpawnProvider(provider: string): SpawnProvider | null;
  forceExitGraceMs: number;
  registeredRepos(): readonly string[];
  projectCodeFor(repo: string): string | null;
  workspaceRoots(): readonly string[];
  /** 子のスレッド表記 (Discord チャンネル等)。 */
  childThread(sessionId: string): string | null;
  hasUnansweredQuestion(sessionId: string): boolean;
  /** 観測した占有トークン (cost 層の estimateContextTokens)。 */
  readContextTokens(session: SessionRow): Promise<number | null>;
  env?: Readonly<Record<string, string | undefined>>;
  intervalMs?: number;
  log: { info(message: string): void; warn(message: string): void };
}

export interface SuccessionRuntime {
  succession: SessionSuccessionService;
  repoAgents: RepoAgentService;
  /** 監視と session.ended 購読を始める。 stop で両方を止める。 */
  start(): AutoSuccessionWatcherHandle;
}

function assistantText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as { role?: unknown; text?: unknown };
  return value.role === "assistant" && typeof value.text === "string" && value.text.trim() ? value.text : null;
}

export function buildSuccessionRuntime(deps: SuccessionRuntimeDeps): SuccessionRuntime {
  const env = deps.env ?? process.env;
  const now = () => Math.floor(Date.now() / 1000);
  const settings = () => readSuccessionSettings(env, deps.log.warn);
  // 自動引き継ぎとリポ担当で 1 つの spawn 枠を共有する (§3.2)。
  const spawnBudget = createSpawnBudget(now);

  const inject = (sessionId: string, text: string, source: string): void => {
    const ts = now();
    eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, author_label: null, ts });
    deps.sessions.appendEvent({ session_id: sessionId, ts, kind: "inject", payload: { text, source } });
  };

  const postLine = (sessionId: string, text: string): void => {
    try {
      const msg = deps.chat.insert({
        channel: "system", session_id: sessionId, author_label: "Concordia (repo-agent)",
        text, in_reply_to: null, is_actionable: false, metadata: null,
      });
      eventBus.emit({
        type: "chat.posted", message_id: msg.id, channel: msg.channel, author_label: msg.author_label,
        session_id: msg.session_id, ts: msg.ts, is_actionable: false,
      });
    } catch (error) {
      // 1 行投稿は一覧 API と inject の写しで、 失敗しても状態は metadata に残る。
      deps.log.warn(`repo-agent: チャンネル投稿失敗 session=${sessionId}: ${(error as Error).message}`);
    }
  };

  const succession = wireSessionSuccessionService({
    sessions: deps.sessions, chat: deps.chat, transcriptLogs: deps.transcriptLogs, controlJobs: deps.controlJobs,
    runClaude: deps.runClaude, toSpawnProvider: deps.toSpawnProvider, forceExitGraceMs: deps.forceExitGraceMs, log: deps.log,
  });

  const repoAgents = createRepoAgentService({
    sessions: deps.sessions,
    settings: () => settings().repoAgents,
    registeredRepos: deps.registeredRepos,
    workspaceRoots: deps.workspaceRoots,
    projectCodeFor: deps.projectCodeFor,
    toSpawnProvider: deps.toSpawnProvider,
    isSessionEnding: isSessionEndPending,
    inject,
    postLine,
    childThread: deps.childThread,
    lastAssistantText: (sessionId) => {
      const frames = deps.transcriptLogs.listBySession(sessionId, { tail: true, limit: LAST_MESSAGE_SCAN_FRAMES });
      for (let i = frames.length - 1; i >= 0; i--) {
        const text = frames[i].kind === "text" ? assistantText(frames[i].payload) : null;
        if (text) return text;
      }
      return null;
    },
    recordPending: (input) => recordPendingRelictor({
      cwd: input.cwd, spawnId: input.spawnId, handoff: input.handoff, kind: "repo-agent", repoAgent: input.repoAgent,
    }),
    forgetPending: forgetPendingRelictorBySpawnId,
    spawn: spawnSession,
    spawnBudget,
    newSpawnId: () => randomUUID(),
    now,
    log: deps.log,
  });

  const watcher = createAutoSuccessionWatcher({
    listActiveSessions: () => deps.sessions.listSessions({ status: "active", limit: MAX_SCANNED_SESSIONS }),
    readContextTokens: deps.readContextTokens,
    lastFrame: (sessionId) => {
      const [last] = deps.transcriptLogs.listBySession(sessionId, { tail: true, limit: 1 });
      return last ? { ts: last.ts, kind: last.kind, payload: last.payload } : null;
    },
    hasUnansweredQuestion: deps.hasUnansweredQuestion,
    isSessionEnding: isSessionEndPending,
    recordAttempt: (sessionId, patch) => deps.sessions.mergeMetadata(sessionId, patch),
    succession,
    repoAgents,
    spawnBudget,
    settings,
    now,
    log: deps.log,
  });

  return {
    succession,
    repoAgents,
    start() {
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type !== "session.ended") return;
        try {
          repoAgents.onSessionEnded(event.session_id);
        } catch (error) {
          // 購読者の失敗で他の購読者・発行元を止めない。
          deps.log.warn(`repo-agent: 終了処理失敗 session=${event.session_id}: ${(error as Error).message}`);
        }
      });
      const handle = startAutoSuccessionWatcher(watcher, deps.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS, deps.log);
      deps.log.info("auto-succession watcher started");
      return {
        stop() {
          handle.stop();
          unsubscribe();
        },
      };
    },
  };
}
