/**
 * 管制まとめに載せる dots (CDGD マネジメント層) の連携状況 (純関数)。
 * 読み取りは management 側 (src/management/status-snapshot.ts) が行い、ここは表示だけを決める。
 *
 * @implements spec/feature/control-session.md §11
 */
import { formatJstClock } from "./jst-clock.js";

/** 任務 1 件の状況。時刻は epoch ミリ秒。 */
export interface DotsMissionSnapshot {
  name: string;
  status: "active" | "stopped";
  /** dots がまだ処理していない (判断を求める) 変更の数。 */
  pendingChanges: number;
  /** 最後に dots が判断を記録した時刻。一度も無ければ null。 */
  lastDecisionAt: number | null;
  waitingHuman: number;
  launchFailed: number;
  running: number;
  reviewIntervalMinutes: number;
}

export type DotsStatusReader = () => readonly DotsMissionSnapshot[];

/** 確認間隔の何倍まで判断が無くても滞りと見なさないか。 */
export const DOTS_STALL_INTERVAL_FACTOR = 2;

/** 未処理の変更があるのに、確認間隔の 2 倍を過ぎても判断が記録されていない。 */
export function isDotsStalled(snapshot: DotsMissionSnapshot, nowMs: number): boolean {
  if (snapshot.status !== "active" || snapshot.pendingChanges <= 0) return false;
  if (snapshot.lastDecisionAt === null) return true;
  return nowMs - snapshot.lastDecisionAt > snapshot.reviewIntervalMinutes * 60_000 * DOTS_STALL_INTERVAL_FACTOR;
}

function missionLine(snapshot: DotsMissionSnapshot, nowMs: number): string {
  if (snapshot.status === "stopped") return `- ${snapshot.name}: 停止中`;
  const parts = [`- ${snapshot.name}: 未処理の変更 ${snapshot.pendingChanges} 件`];
  parts.push(snapshot.lastDecisionAt === null ? "判断の記録なし" : `最後の判断 ${formatJstClock(Math.floor(snapshot.lastDecisionAt / 1000))} JST`);
  parts.push(`実行中 ${snapshot.running}`);
  if (snapshot.waitingHuman) parts.push(`人間の判断待ち ${snapshot.waitingHuman}`);
  if (snapshot.launchFailed) parts.push(`起動失敗 ${snapshot.launchFailed}`);
  if (isDotsStalled(snapshot, nowMs)) parts.push("⚠ dots の判断が止まっています");
  return parts.join(" / ");
}

/** 任務が 1 件も無ければ何も載せない。読み取りに失敗したら (null) その旨だけを載せる。 */
export function renderDotsStatusLines(snapshots: readonly DotsMissionSnapshot[] | null, nowMs: number): string[] {
  if (snapshots === null) return ["dots 連携: 状況を読めませんでした"];
  if (snapshots.length === 0) return [];
  const active = snapshots.filter((s) => s.status === "active").length;
  return [`dots 連携: 任務 ${snapshots.length} 件 (動作中 ${active})`, ...snapshots.map((s) => missionLine(s, nowMs))];
}

/** 読み取りの失敗でまとめ全体を止めない。 */
export function readDotsStatusSafely(
  read: DotsStatusReader | undefined, log: { warn(message: string): void },
): readonly DotsMissionSnapshot[] | null {
  if (!read) return [];
  try {
    return read();
  } catch (error) {
    log.warn(`[control-session] dots status read failed: ${(error as Error).message}`);
    return null;
  }
}
