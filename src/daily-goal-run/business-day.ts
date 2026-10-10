/**
 * 業務日と締切の計算 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 用語 (その日 = 朝 4:00 から翌朝 4:00) / 8. 4:00 の締切
 *
 * 業務日は境界 (既定 04:00) から翌日の境界まで。 日付は始まりの境界の日付 (ローカル時刻) で呼ぶ。
 * 10/11 の 2:00 は 10/10 の業務日。 締切は翌日の境界。
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:7b2bdb88 */
import augurContract_5c074482 from './business-date.contract.js'; /* augur-inject:contract-predicate:a02d91ef */

export const DEFAULT_DAY_BOUNDARY = "04:00";
export const DEFAULT_REMINDER_TIME = "09:00";

export interface Clock { hour: number; minute: number }

/** "HH:MM" を時・分に直す。 不正な値は fallback ("HH:MM")。 */
export function parseClock(value: string | null | undefined, fallback: string): Clock {
  const parse = (raw: string): Clock | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  };
  return parse(value ?? "") ?? parse(fallback) ?? { hour: 0, minute: 0 };
}

export function formatClock(clock: Clock): string {
  return `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

/** ローカル日付 YYYY-MM-DD。 */
export function localDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 日付 (YYYY-MM-DD) に days 日を足す。 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y!, (m ?? 1) - 1, (d ?? 1) + days, 12).getTime());
}

/** 日付のローカル時刻 HH:MM の epoch ms。 */
export function localTimeOn(date: string, clock: string, fallback = DEFAULT_DAY_BOUNDARY): number {
  const [y, m, d] = date.split("-").map(Number);
  const { hour, minute } = parseClock(clock, fallback);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, hour, minute, 0, 0).getTime();
}

/** now が属する業務日。 境界より前の時刻は前日の業務日。 */
export function businessDateOf(now: number, boundary: string = DEFAULT_DAY_BOUNDARY): string {
  const today = localDate(now);
  return now < localTimeOn(today, boundary) ? addDays(today, -1) : today;
}
// @ts-expect-error augur-inject
businessDateOf = contract(businessDateOf, { ...augurContract_5c074482, contractId: 'dg-C-7', mode: 'observe', sample: 1, where: 'src/daily-goal-run/business-day.ts:52', rule: 'contract-wrap', id: '5c074482' }); /* augur-inject:contract-wrap:5c074482 */

/** 業務日の始まり (その日の境界)。 */
export function businessDayStart(businessDate: string, boundary: string = DEFAULT_DAY_BOUNDARY): number {
  return localTimeOn(businessDate, boundary);
}

/** 業務日の締切 (翌日の境界)。 */
export function deadlineOf(businessDate: string, boundary: string = DEFAULT_DAY_BOUNDARY): number {
  return localTimeOn(addDays(businessDate, 1), boundary);
}

/** 締切の表示 (例 `10/11 04:00`)。 */
export function describeDeadline(businessDate: string, boundary: string = DEFAULT_DAY_BOUNDARY): string {
  const next = addDays(businessDate, 1).split("-");
  return `${Number(next[1])}/${Number(next[2])} ${formatClock(parseClock(boundary, DEFAULT_DAY_BOUNDARY))}`;
}
