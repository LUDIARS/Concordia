/**
 * 管制の組み立て: 巡回・指示の届け方・管制チャンネル・API の口を 1 か所でつなぐ。
 * Discord 面は attachChannel で後から差し込む (Bot が無い構成でも巡回と API は動く)。
 *
 * @implements spec/feature/control-session.md §4 §6 §7 §10
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SettingsStore } from "../admin/settings-store.js";
import type { SessionRow } from "../shared/types.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";
import { ControlBoardRepo } from "./board-repo.js";
import type { ControlChannelSurface } from "./channel-surface.js";
import { handleControlChannelPost, renderDispatchSummary, type ControlChannelPost } from "./channel-service.js";
import { CONTROL_START_PROMPT, prepareControlWorkspace } from "./charter.js";
import type { ClassifyFactPorts } from "./classify-facts.js";
import { createEndedLog } from "./ended-log.js";
import { ControlHolderStore } from "./holder-store.js";
import { CONTROL_SUMMARY_POSTED_KEY, isSummaryDue, parseSummaryPostedAt, renderHourlySummary } from "./hourly-summary.js";
import { readDotsStatusSafely, renderDotsStatusLines, type DotsStatusReader } from "./dots-status.js";
import { renderExternalBridgeLines, type ExternalBridgeReader } from "./external-bridge-status.js";
import type { EligibilityProbes } from "./instruction-eligibility.js";
import {
  CONTROL_INJECT_SOURCE,
  dispatchControlInstruction,
  type DispatchResult,
  type InjectPort,
  type InstructionOrigin,
} from "./instruction-dispatch.js";
import { createControlPatrol } from "./patrol.js";
import { createChildReaper, type ChildReaperDeps } from "./reaper.js";
import { safeLinkResolver, withSessionLinks, type ControlBoardRowWithLink, type SessionLinkResolver } from "./session-link.js";
import { createSideDialogue, type OneShotRunner } from "./side-dialogue.js";
import { createControlSupervisor, type ControlTickReport } from "./supervisor.js";

export const CONTROL_TICK_MS = 60 * 1000;

export type { ControlChannelSurface } from "./channel-surface.js";

export interface ControlRuntimeDeps {
  db: Database.Database;
  settings: Pick<SettingsStore, "get" | "set" | "delete">;
  isEnabled(): boolean;
  /** Cc 内の管制セッション本体を動かすか (v5 の既定 false)。未注入は true。 */
  isBodyEnabled?(): boolean;
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
  /** 分類と停止への追加指示 (§2 §4) に使う照会。無ければ分類しない。 */
  patrol?: Omit<ClassifyFactPorts, "probes">;
  /**
   * 判断が要るセッションへ飛ぶリンク (§10)。質問カードのメッセージ URL かセッションのチャンネル/スレッドの URL。
   * 無ければリンク無し (従来どおり)。例外はリンク無しにして警告ログに残す。
   */
  sessionLink?: SessionLinkResolver;
  /** 管制まとめに載せる dots の連携状況 (§11)。無ければ載せない。 */
  dotsStatus?: DotsStatusReader;
  externalBridges?: ExternalBridgeReader;
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

  // 巡回と一括指示へ渡す照会。repo のメソッドを裸で渡すと this が外れる (SessionsRepo は this.db を読む) ので受け手ごと包む。
  const findSession = (sessionId: string): SessionRow | null => deps.sessions.findSession(sessionId);

  // 管制セッション自身かは supervisor が知っているので、判定は遅延で結ぶ。
  let isControl: (session: Pick<SessionRow, "metadata">) => boolean = () => false;
  const probes: EligibilityProbes = {
    ...deps.probes,
    isControlSession: (sessionId) => {
      const session = findSession(sessionId);
      return !!session && isControl(session);
    },
  };

  const supervisor = createControlSupervisor({
    isEnabled: deps.isEnabled,
    ...(deps.isBodyEnabled ? { isBodyEnabled: deps.isBodyEnabled } : {}),
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
  const endedLog = createEndedLog(deps.settings);
  const linkOf = safeLinkResolver(deps.sessionLink, deps.log);
  const linkedBoardRows = (): ControlBoardRowWithLink[] => withSessionLinks(board.list(), linkOf);

  async function postAlert(text: string): Promise<boolean> {
    if (!surface) return false;
    try {
      return (await surface.post(text)) !== false;
    } catch (error) {
      deps.log.warn(`control channel post failed: ${String(error)}`);
      return false;
    }
  }

  const postIfReady = (text: string): Promise<boolean> => surfaceReady ? postAlert(text) : Promise.resolve(false);

  const patrol = deps.patrol ? createControlPatrol({
    board,
    facts: { ...deps.patrol, probes: deps.probes },
    findSession,
    probes,
    inject: deps.inject,
    postToChannel: postIfReady,
    now,
    log: deps.log,
  }) : null;

  const reaper = deps.reaper ? createChildReaper({
    ...deps.reaper,
    isControlSession: (session) => supervisor.isControlSession(session),
    postToChannel: async (text) => { if (surface && surfaceReady) await surface.post(text); },
    now,
    log: deps.log,
  }) : null;

  async function dispatch(input: { targets: string[]; text: string; origin: InstructionOrigin }): Promise<DispatchResult> {
    const result = await dispatchControlInstruction({
      ...input, findSession, probes, inject: deps.inject, nowMs: now(),
    });
    if (surface && result.delivered.length) {
      const who = input.origin.kind === "control" ? `管制セッション第 ${input.origin.generation} 世代`
        : input.origin.kind === "patrol" ? "管制の巡回" : input.origin.label;
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
      endedLog.clear();
      return report;
    }
    if (patrol) {
      const targets = deps.sessions.findAllActive().filter((session) => !supervisor.isControlSession(session));
      await patrol.runOnce(targets).catch((error) => deps.log.warn(`control patrol failed: ${String(error)}`));
    }
    if (reaper) {
      const reaped = await reaper.runOnce(deps.sessions.findAllActive())
        .catch((error) => { deps.log.warn(`control reaper failed: ${String(error)}`); return null; });
      const nowSec = Math.floor(now() / 1000);
      endedLog.append((reaped?.endedDetail ?? []).map((item) => ({
        session_id: item.session_id, project: board.find(item.session_id)?.project ?? "unknown", reason: item.reason, ended_at: nowSec,
      })));
    }
    if (surface && surfaceReady) await postHourlySummary(surface);
    return report;
  }

  /** ボードだけを読み、1 時間に 1 回まとめを投げる。投稿に成功したときだけ時刻を残す (CC-CTL-INV-07)。 */
  async function postHourlySummary(target: ControlChannelSurface): Promise<void> {
    const nowMs = now();
    if (!isSummaryDue(parseSummaryPostedAt(deps.settings.get(CONTROL_SUMMARY_POSTED_KEY)), nowMs)) return;
    try {
      const dotsLines = renderDotsStatusLines(readDotsStatusSafely(deps.dotsStatus, deps.log), nowMs);
      const bridgeLines = renderExternalBridgeLines(deps.externalBridges?.() ?? []);
      await target.post(renderHourlySummary(board.list(), nowMs, endedLog.list(), linkOf, [...dotsLines, ...bridgeLines]));
      deps.settings.set(CONTROL_SUMMARY_POSTED_KEY, String(nowMs));
      endedLog.clear();
    } catch (error) {
      deps.log.warn(`control hourly summary failed: ${String(error)}`);
    }
  }

  return {
    tick,
    postAlert,
    sessionLink: linkOf,
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
      boardRows: linkedBoardRows,
      dispatch,
      answer: (input) => side.answer(input),
      nowSec: () => Math.floor(now() / 1000),
    }, post),
    api: {
      isEnabled: deps.isEnabled,
      holder: () => holders.read(),
      currentControlSessionId: () => supervisor.currentControlSessionId(),
      boardRows: linkedBoardRows,
      dispatch,
    },
    injectSource: CONTROL_INJECT_SOURCE,
  };
}

export type ControlRuntime = ReturnType<typeof createControlRuntime>;
