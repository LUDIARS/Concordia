/**
 * 専用セッションの起動時刻の判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 3. 専用セッションを起動する
 *
 * 起動時刻 (既定 07:30) までに確定したゴールはその時刻に、 以降に確定したゴールは
 * 確定した時点で起動する。 日付はローカル時刻で扱う。
 */

import type { DailyGoal } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:a8225bf9 */
import augurContract_df58a4d6 from './launch-at.contract.js'; /* augur-inject:contract-predicate:c4e9dc19 */

export const DEFAULT_LAUNCH_TIME = "07:30";

/** "HH:MM" を分に直す。 不正な値は既定 07:30。 */
export function parseLaunchTime(value: string | null | undefined): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  return { hour: 7, minute: 30 };
}

/** ローカル日付 YYYY-MM-DD。 */
export function localDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 指定日付のローカル時刻 HH:MM の epoch ms。 */
export function localTimeOn(date: string, time: string | null | undefined): number {
  const [y, m, d] = date.split("-").map(Number);
  const { hour, minute } = parseLaunchTime(time);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, hour, minute, 0, 0).getTime();
}

/** 起動してよい時刻。 起動時刻より前の確定は起動時刻、 以降は確定時刻。 */
export function launchAt(confirmedAt: number, date: string, launchTime: string = DEFAULT_LAUNCH_TIME): number {
  return Math.max(confirmedAt, localTimeOn(date, launchTime));
}
// @ts-expect-error augur-inject
launchAt = contract(launchAt, { ...augurContract_df58a4d6, contractId: 'dg-C-3', mode: 'observe', sample: 1, where: 'src/daily-goal-run/launch-policy.ts:40', rule: 'contract-wrap', id: 'df58a4d6' }); /* augur-inject:contract-wrap:df58a4d6 */

/** 起動の期限が来ているか。 確定済み・起動未着手・バックオフ明けのゴールだけが対象。 */
export function isDue(goal: DailyGoal, now: number, launchTime: string = DEFAULT_LAUNCH_TIME): boolean {
  if (goal.status !== "confirmed" || goal.launchState !== "none") return false;
  if (goal.nextLaunchAt !== undefined && goal.nextLaunchAt > now) return false;
  return now >= launchAt(goal.confirmedAt, goal.date, launchTime);
}

/** 候補カードを出す時刻 (起動時刻の 30 分前)。 */
export function candidateAt(date: string, launchTime: string = DEFAULT_LAUNCH_TIME): number {
  return localTimeOn(date, launchTime) - 30 * 60_000;
}

/** 次の日付 (YYYY-MM-DD)。 */
export function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y!, (m ?? 1) - 1, (d ?? 1) + 1, 12).getTime());
}
