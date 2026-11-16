/**
 * 管制の組み立て: 巡回・指示の届け方・管制チャンネル・API の口を 1 か所でつなぐ。
 * Discord 面は attachChannel で後から差し込む (Bot が無い構成でも巡回と API は動く)。
 *
 * @implements spec/feature/control-session.md — 構成要素と状態の所有者 / 6. ON / OFF / 7. 1 時間ごとのまとめ
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SettingsStore } from "../admin/settings-store.js";
import type { SessionRow } from "../shared/types.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";
import { ControlBoardRepo, type ControlBoardRow } from "./board-repo.js";
import type { ControlChannelSurface } from "./channel-surface.js";
import { handleControlChannelPost, renderDispatchSummary, type ControlChannelPost } from "./channel-service.js";
import { CONTROL_START_PROMPT, prepareControlWorkspace } from "./charter.js";
import { ControlHolderStore } from "./holder-store.js";
import { CONTROL_SUMMARY_POSTED_KEY, isSummaryDue, parseSummaryPostedAt, renderHourlySummary } from "./hourly-summary.js";
import type { EligibilityProbes } from "./instruction-eligibility.js";
import {
  CONTROL_INJECT_SOURCE,
  dispatchControlInstruction,
  type DispatchResult,
  type InjectPort,
  type InstructionOrigin,
} from "./instruction-dispatch.js";
import { createChildReaper, type ChildReaperDeps } from "./reaper.js";
import { createSideDialogue, type OneShotRunner } from "./side-dialogue.js";
import { createControlSupervisor, type ControlTickReport } from "./supervisor.js";

export const CONTROL_TICK_MS = 60 * 1000;

export type { ControlChannelSurface } from "./channel-surface.js";

export interface ControlRuntimeDeps {
  db: Database.Database;
  settings: Pick<SettingsStore, "get" | "set" | "delete">;
  isEnabled(): boolean;
  sessions: { findAllActive(): SessionRow[]; findSession(id: string): SessionRow | null };
  projectOf(session: SessionRow): string;
  latestStat(sessionId: string): { ts: number; payload: string } | null;
  lastActivitySec(sessionId: string): number | null;
  /** 管制以外の待ちの判定 (管制セッション自身の判定はここで足す)。 */
  probes: Omit<EligibilityProbes, "isControlSession">;
  inject: InjectPort;
  /** 管制セッション本体への案内・要約 (source は巡回用)。 */
  injectToSession(sessionId: string, text: string): boolean;
  spawn(input: { spawnId: string; cwd: string; title: string; prompt: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * spawn ID を Cc 起動の登録 (enrollment) として先に記録する / 取り消す。記録が無いと起動した Lictor の
   * セッション登録が invalid_or_consumed_session_enrollment で拒否され、作業場所の trust も焼かれない。
   */
  enrollment: { record(input: { spawnId: string; cwd: string }): void; forget(spawnId: string): void };
  workspaceRoot(): string;
  concordiaUrl: string;
  runOneShot: OneShotRunner;
  /** 作業指示で起動した子セッションの片付け (§9)。管制が ON の間だけ巡回ごとに回す。 */
  reaper?: Omit<ChildReaperDeps, "isControlSession" | "postToChannel" | "now" | "log">;
  now?: () => number;
  log: { info(message: string): void; warn(message: string): void };
}

export function createControlRuntime(deps: ControlRuntimeDeps) {
  const now = deps.now ?? Date.now;
  const board = new ControlBoardRepo(deps.db);
  const holders = new ControlHolderStore(deps.settings);
  let surface: ControlChannelSurface | null = null;
  let surfaceReady = false;
  let loop: SupervisedIntervalHandle | null = null;

  // 管制セッション自身かは supervisor が知っているので、判定は遅延で結ぶ。
  let isControl: (session: Pick<SessionRow, "metadata">) => boolean = () => false;
  const probes: EligibilityProbes = {
    ...deps.probes,
    isControlSession: (sessionId) => {
      const session = deps.sessions.findSession(sessionId);
      return !!session && isControl(session);
    },
  };

  const supervisor = createControlSupervisor({
    isEnabled: deps.isEnabled,
    sessions: deps.sessions,
    holders,
    board,
    projectOf: deps.projectOf,
    latestStat: deps.latestStat,
    lastActivitySec: deps.lastActivitySec,
    newSpawnId: randomUUID,
    spawnControl: async ({ spawnId, generation }) => {
      try {
        const cwd = await prepareControlWorkspace({ workspaceRoot: deps.workspaceRoot(), concordiaUrl: deps.concordiaUrl, generation });
        deps.enrollment.record({ spawnId, cwd });
        const result = await deps.spawn({ spawnId, cwd, title: `[管制] 第 ${generation} 世代`, prompt: CONTROL_START_PROMPT });
        if (!result.ok) deps.enrollment.forget(spawnId);
        return result;
      } catch (error) {
        deps.enrollment.forget(spawnId);
        return { ok: false, error: String(error) };
      }
    },
    injectToControl: deps.injectToSession,
    probes,
    now,
    log: deps.log,
  });
  isControl = supervisor.isControlSession;

  const side = createSideDialogue(deps.runOneShot);

  const reaper = deps.reaper ? createChildReaper({
    ...deps.reaper,
    isControlSession: (session) => supervisor.isControlSession(session),
    postToChannel: async (text) => { if (surface && surfaceReady) await surface.post(text); },
    now,
    log: deps.log,
  }) : null;

  async function dispatch(input: { targets: string[]; text: string; origin: InstructionOrigin }): Promise<DispatchResult> {
    const result = await dispatchControlInstruction({
      ...input, findSession: deps.sessions.findSession, probes, inject: deps.inject, nowMs: now(),
    });
    if (surface && result.delivered.length) {
      const who = input.origin.kind === "control" ? `管制セッション第 ${input.origin.generation} 世代` : input.origin.label;
      await surface.post([`${who} の指示を届けました: ${result.delivered.join(", ")}`, renderDispatchSummary(result)].join("\n"))
        .catch((error) => deps.log.warn(`control channel notice failed: ${String(error)}`));
    }
    return result;
  }

  async function tick(): Promise<ControlTickReport> {
    const report = await supervisor.runOnce();
    if (report.enabled && surface && !surfaceReady) {
      await surface.ensure().then(() => { surfaceReady = true; })
        .catch((error) => deps.log.warn(`control channel unavailable: ${String(error)}`));
    }
    if (!report.enabled) {
      surfaceReady = false;
      deps.settings.delete(CONTROL_SUMMARY_POSTED_KEY);
    }
    if (report.enabled && surface && surfaceReady) await postHourlySummary(surface);
    if (report.enabled && reaper) {
      await reaper.runOnce(deps.sessions.findAllActive())
        .catch((error) => deps.log.warn(`control reaper failed: ${String(error)}`));
    }
    return report;
  }

  /** ボードだけを読み、1 時間に 1 回まとめを投げる。投稿に成功したときだけ時刻を残す (CC-CTL-INV-07)。 */
  async function postHourlySummary(target: ControlChannelSurface): Promise<void> {
    const nowMs = now();
    if (!isSummaryDue(parseSummaryPostedAt(deps.settings.get(CONTROL_SUMMARY_POSTED_KEY)), nowMs)) return;
    try {
      await target.post(renderHourlySummary(board.list(), nowMs));
      deps.settings.set(CONTROL_SUMMARY_POSTED_KEY, String(nowMs));
    } catch (error) {
      deps.log.warn(`control hourly summary failed: ${String(error)}`);
    }
  }

  return {
    tick,
    start(intervalMs = CONTROL_TICK_MS): { stop(): void } {
      loop?.stop();
      loop = startSupervisedInterval("control-session", async () => { await tick(); }, {
        intervalMs, log: { warn: (message) => deps.log.warn(message) },
      });
      return { stop: () => { loop?.stop(); loop = null; } };
    },
    attachChannel(next: ControlChannelSurface | null): void {
      surface = next;
      surfaceReady = false;
    },
    /** 停止確認・Goal & Go・現況報告から外す判定 (管制の文脈を汚さない)。 */
    isControlSession: (session: Pick<SessionRow, "metadata">) => supervisor.isControlSession(session),
    handleChannelPost: (post: ControlChannelPost) => handleControlChannelPost({
      isEnabled: deps.isEnabled,
      activeSessions: () => deps.sessions.findAllActive(),
      projectOf: deps.projectOf,
      isControlSession: (session) => supervisor.isControlSession(session),
      boardRows: (): ControlBoardRow[] => board.list(),
      dispatch,
      answer: (input) => side.answer(input),
      nowSec: () => Math.floor(now() / 1000),
    }, post),
    api: {
      isEnabled: deps.isEnabled,
      holder: () => holders.read(),
      currentControlSessionId: () => supervisor.currentControlSessionId(),
      boardRows: () => board.list(),
      dispatch,
    },
    injectSource: CONTROL_INJECT_SOURCE,
  };
}

export type ControlRuntime = ReturnType<typeof createControlRuntime>;
