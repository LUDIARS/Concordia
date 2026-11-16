/**
 * 作業指示で起動した子セッションの片付け。巡回ごとに対象の子を判定し、
 * 先に案内を 1 回送り、猶予後も閉じてよければ既存のセッション終了経路で閉じる。
 * 終了の結果が分からないときは再送しない (試みた記録を残し、状態で照合する)。
 *
 * @implements spec/feature/control-session.md — 9. 子セッションの片付け / CC-CTL-INV-08
 */
import type { SessionRow } from "../shared/types.js";
import { gatherReapInput, type ReaperFactPorts } from "./reaper-facts.js";
import {
  classifyChild,
  decideReap,
  nextReapStep,
  parseReapState,
  REAP_DONE_IDLE_SEC,
  REAP_STATE_METADATA_KEY,
  type ReapReason,
} from "./reaper-policy.js";

export const CONTROL_REAPER_SOURCE = "auto:control-reaper";

export const CONTROL_REAPER_NOTICE =
  "[管制] このセッションは役目を終えたか、反応が無いと判断しました。作業記録を残して session-end してください。まだ続ける作業がある場合は作業を続けてください (会話が再開すれば閉じる条件から外れます)。10 分後も同じ状態なら Cc がこのセッションを終了します。";

const REASON_LABEL: Record<ReapReason, string> = {
  done_delegation: "委託 run の終了を親が受け取り済み",
  done_repo_agent: "担当 PR がマージ済み",
  unresponsive: "長く会話が無く自動確認にも反応が無い",
};

export interface ChildReaperDeps extends ReaperFactPorts {
  isEnabled(): boolean;
  findRun(runId: string): { child_session_id: string | null; parent_session_id: string | null } | null;
  isResidentChild(sessionId: string): boolean;
  isControlSession(session: SessionRow): boolean;
  updateMetadata(sessionId: string, update: (current: Record<string, unknown>) => Record<string, unknown>): void;
  /** 子・親への案内 (届かなければ false)。 */
  inject(sessionId: string, text: string): boolean;
  /** 既存のセッション終了経路 (DELETE /v1/sessions/:id)。プロセスを直接 kill しない。 */
  endSession(sessionId: string): Promise<void>;
  /** 管制チャンネルへの通知 (件数と対象だけ)。無ければ送らない。 */
  postToChannel(text: string): Promise<void>;
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

export interface ReaperTickReport {
  noticed: string[];
  ended: string[];
  failed: string[];
}

function metadataOf(session: SessionRow): Record<string, unknown> {
  try {
    const value = JSON.parse(session.metadata ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function createChildReaper(deps: ChildReaperDeps) {
  function writeState(sessionId: string, patch: Record<string, unknown>): void {
    deps.updateMetadata(sessionId, (current) => ({
      ...current,
      [REAP_STATE_METADATA_KEY]: { ...(current[REAP_STATE_METADATA_KEY] as Record<string, unknown> | undefined ?? {}), ...patch },
    }));
  }

  async function end(session: SessionRow, parentId: string, reason: ReapReason, nowSec: number): Promise<boolean> {
    deps.inject(parentId, `[管制] 子セッション ${session.id} を閉じます (${REASON_LABEL[reason]})。`);
    // 結果が分からなくても再送しないよう、試みる前に記録する。
    writeState(session.id, { end_attempted_at: nowSec });
    try {
      await deps.endSession(session.id);
      deps.inject(parentId, `[管制] 子セッション ${session.id} を閉じました。`);
      return true;
    } catch (error) {
      deps.log.warn(`control reaper: end failed session=${session.id}: ${String(error)}`);
      deps.inject(parentId, `[管制] 子セッション ${session.id} の終了結果が分かりません。再送はしません。状態を確かめてください。`);
      return false;
    }
  }

  async function runOnce(active: readonly SessionRow[]): Promise<ReaperTickReport> {
    const report: ReaperTickReport = { noticed: [], ended: [], failed: [] };
    if (!deps.isEnabled()) return report;
    const nowSec = Math.floor(deps.now() / 1000);
    // open PR の一覧は 1 巡回で 1 回だけ読む。
    let openPrs: ReturnType<ChildReaperDeps["listOpenLocalPrs"]> | null = null;
    const ports: ChildReaperDeps = { ...deps, listOpenLocalPrs: () => (openPrs ??= deps.listOpenLocalPrs()) };
    for (const session of active) {
      if (deps.isControlSession(session) || deps.isResidentChild(session.id)) continue;
      const metadata = metadataOf(session);
      const link = classifyChild({ sessionId: session.id, metadata, findRun: deps.findRun });
      if (!link) continue;
      const state = parseReapState(metadata[REAP_STATE_METADATA_KEY]);
      if (state?.end_attempted_at) continue;
      // 会話がまだ新しい子は、どの条件にも当たらないので照会しない (git / Revisor を叩かない)。
      const last = deps.lastActivitySec(session.id);
      if (last !== null && nowSec - last < REAP_DONE_IDLE_SEC) continue;
      const verdict = decideReap(await gatherReapInput(ports, session, link, nowSec));
      const step = nextReapStep(verdict, state, nowSec);
      if (!verdict.eligible) continue;
      if (step === "notice") {
        if (!deps.inject(session.id, CONTROL_REAPER_NOTICE)) continue;
        writeState(session.id, { noticed_at: nowSec, reason: verdict.reason, end_attempted_at: null });
        deps.inject(link.parentSessionId, `[管制] 子セッション ${session.id} に終了を案内しました (${REASON_LABEL[verdict.reason]})。10 分後も同じ状態なら閉じます。`);
        report.noticed.push(session.id);
      } else if (step === "end") {
        (await end(session, link.parentSessionId, verdict.reason, nowSec) ? report.ended : report.failed).push(session.id);
      }
    }
    const lines = [
      report.noticed.length ? `終了を案内: ${report.noticed.length} 件 (${report.noticed.join(", ")})` : null,
      report.ended.length ? `閉じた: ${report.ended.length} 件 (${report.ended.join(", ")})` : null,
      report.failed.length ? `終了結果が不明: ${report.failed.length} 件 (${report.failed.join(", ")})` : null,
    ].filter((line): line is string => line !== null);
    if (lines.length) {
      await deps.postToChannel(["🧹 [管制] 子セッションの片付け", ...lines].join("\n"))
        .catch((error) => deps.log.warn(`control reaper: channel notice failed: ${String(error)}`));
    }
    return report;
  }

  return { runOnce };
}
