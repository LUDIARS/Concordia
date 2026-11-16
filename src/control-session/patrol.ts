/**
 * 管制の巡回のうち「分類して行動する」部分。巡回ごとにボードの各行を分類し、
 * 停止・応答なしへは管制 runtime が自分で追加指示を送り (stall-nudge のゲートに依存しない)、
 * 応答なしへ上がったものは管制チャンネルへ名指しで報告する。人間待ち・審査待ちには送らないが理由は残す。
 *
 * @implements spec/feature/control-session.md §2 §4
 */
import { classifySession, type SessionClassification } from "../control/session-classify.js";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import type { SessionRow } from "../shared/types.js";
import type { ControlBoardRepo, ControlBoardRow } from "./board-repo.js";
import { gatherClassifyInput, type ClassifyFactPorts } from "./classify-facts.js";
import { dispatchControlInstruction, type InjectPort } from "./instruction-dispatch.js";
import type { EligibilityProbes } from "./instruction-eligibility.js";
import { formatJstClock } from "./jst-clock.js";
import {
  renderPatrolNudge,
  settleNudgeState,
  shouldReportUnresponsive,
  shouldSendPatrolNudge,
  type PatrolNudgeState,
} from "./patrol-nudge-policy.js";

export interface ControlPatrolDeps {
  board: Pick<ControlBoardRepo, "find" | "saveClassification">;
  facts: ClassifyFactPorts;
  findSession(sessionId: string): SessionRow | null;
  probes: EligibilityProbes;
  inject: InjectPort;
  /** 管制チャンネルへの投稿。チャンネルが無い・失敗なら false。 */
  postToChannel(text: string): Promise<boolean>;
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

export interface PatrolTickReport {
  classified: Array<{ session_id: string } & SessionClassification>;
  nudged: string[];
  unresponsiveReported: string[];
}

function nudgeStateOf(row: ControlBoardRow): PatrolNudgeState {
  return { count: row.nudge_count ?? 0, lastAt: row.nudge_last_at ?? null, reportedAt: row.unresponsive_reported_at ?? null };
}

export function renderUnresponsiveReport(rows: ReadonlyArray<{ row: ControlBoardRow; reason: string; lastNudgeAt: number | null }>): string {
  return [
    "📵 [管制] 応答なしのセッションがあります (追加指示が届いても会話が進まない)。",
    ...rows.map(({ row, reason, lastNudgeAt }) => [
      `- ${row.project} ${row.session_id}`,
      reason,
      lastNudgeAt !== null ? `直近の追加指示 ${formatJstClock(lastNudgeAt)} JST` : null,
    ].filter((part): part is string => part !== null).join(" / ")),
  ].join("\n").replace(/@/g, "＠");
}

export function createControlPatrol(deps: ControlPatrolDeps) {
  async function runOnce(active: readonly SessionRow[]): Promise<PatrolTickReport> {
    const report: PatrolTickReport = { classified: [], nudged: [], unresponsiveReported: [] };
    const nowSec = Math.floor(deps.now() / 1000);
    // 審査中 PR の一覧は 1 巡回で 1 回だけ読む。読めなければ null (= 審査状況不明で待つ側)。
    let openPrs: Promise<RevisorLocalPr[] | null> | null = null;
    const readOpenPrs = () => (openPrs ??= deps.facts.listOpenLocalPrs().catch(() => null));
    const toReport: Array<{ row: ControlBoardRow; reason: string; lastNudgeAt: number | null }> = [];
    const states = new Map<string, PatrolNudgeState>();

    for (const session of active) {
      const row = deps.board.find(session.id);
      if (!row) continue;
      let state = settleNudgeState(nudgeStateOf(row), row.last_activity_at);
      const input = await gatherClassifyInput({
        ports: deps.facts, session, lastActivitySec: row.last_activity_at, nudge: state, openPrs: readOpenPrs, nowSec,
      });
      const verdict = classifySession(input);
      report.classified.push({ session_id: session.id, ...verdict });

      if (shouldSendPatrolNudge(verdict.status, state, nowSec)) {
        const result = await dispatchControlInstruction({
          targets: [session.id],
          text: renderPatrolNudge({ count: state.count + 1, idleMinutes: Math.floor((input.idleSec ?? 0) / 60), reason: verdict.reason }),
          origin: { kind: "patrol" },
          findSession: deps.findSession,
          probes: deps.probes,
          inject: deps.inject,
          nowMs: nowSec * 1000,
        });
        if (result.delivered.includes(session.id)) {
          state = { ...state, count: state.count + 1, lastAt: nowSec };
          report.nudged.push(session.id);
        } else {
          deps.log.info(`control patrol: nudge not delivered session=${session.id} reason=${result.skipped[0]?.reason ?? "unknown"}`);
        }
      }
      if (shouldReportUnresponsive(verdict.status, state)) toReport.push({ row, reason: verdict.reason, lastNudgeAt: state.lastAt });
      states.set(session.id, state);
      deps.board.saveClassification(session.id, {
        status: verdict.status, status_reason: verdict.reason, classified_at: nowSec,
        nudge_count: state.count, nudge_last_at: state.lastAt, unresponsive_reported_at: state.reportedAt,
      });
    }

    if (toReport.length && await deps.postToChannel(renderUnresponsiveReport(toReport)).catch(() => false)) {
      for (const { row } of toReport) {
        const state = states.get(row.session_id)!;
        const verdict = report.classified.find((c) => c.session_id === row.session_id)!;
        deps.board.saveClassification(row.session_id, {
          status: verdict.status, status_reason: verdict.reason, classified_at: nowSec,
          nudge_count: state.count, nudge_last_at: state.lastAt, unresponsive_reported_at: nowSec,
        });
        report.unresponsiveReported.push(row.session_id);
      }
    }
    if (report.nudged.length) {
      deps.log.info(`control patrol: nudged ${report.nudged.length} stalled session(s): ${report.nudged.join(", ")}`);
    }
    return report;
  }

  return { runOnce };
}

export type ControlPatrol = ReturnType<typeof createControlPatrol>;
