/**
 * 散歩セッションの発火タイミング (spec/feature/curiosity-walk.md §2)。
 *
 * ポアソン過程で「活動時間 1 日あたり平均 λ 回」。等間隔にしない。
 * 発火間隔は活動時間 (既定 10:00〜22:00 JST) の経過時間に対して適用し、
 * 活動時間帯の外へ掛かった残り待ち時間は次の活動時間帯へ繰り越す。
 * 純関数のみ (実タイマーは walk-runtime.ts)。
 */

export interface WalkScheduleOpts {
  /** 活動時間 1 日あたりの平均発火回数。既定 2.5。 */
  lambdaPerDay?: number;
  /** 活動時間帯の開始時 (JST, 0-23)。既定 10。 */
  activeStartHour?: number;
  /** 活動時間帯の終了時 (JST, 0-24)。既定 22。 */
  activeEndHour?: number;
}

const DEFAULTS: Required<WalkScheduleOpts> = {
  lambdaPerDay: 2.5,
  activeStartHour: 10,
  activeEndHour: 22,
};

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** now (epoch-ms) の JST 日内オフセット (ms)。 */
function jstTimeOfDayMs(nowMs: number): number {
  return ((nowMs + JST_OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS;
}

/**
 * 指数分布から次の発火までの「活動時間」を引き、活動時間帯を歩いて実時間の遅延へ写す。
 * rand は [0,1) の一様乱数 (テストで差し替える)。
 */
export function nextWalkDelayMs(nowMs: number, rand: () => number, opts?: WalkScheduleOpts): number {
  const { lambdaPerDay, activeStartHour, activeEndHour } = { ...DEFAULTS, ...opts };
  const activePerDayMs = Math.max(1, (activeEndHour - activeStartHour)) * 3600_000;
  // 指数分布: -ln(1-u) / λ。λ は「活動 ms あたりの発火率」。
  const u = Math.min(Math.max(rand(), 0), 1 - 1e-12);
  let remainingActiveMs = -Math.log(1 - u) / (lambdaPerDay / activePerDayMs);

  const startMs = activeStartHour * 3600_000;
  const endMs = activeEndHour * 3600_000;
  let cursor = nowMs;
  // 活動時間だけを消費しながら前へ歩く (非活動帯は素通り = 繰り越し)。
  for (let guard = 0; guard < 400; guard += 1) {
    const tod = jstTimeOfDayMs(cursor);
    if (tod < startMs) {
      cursor += startMs - tod;
      continue;
    }
    if (tod >= endMs) {
      cursor += DAY_MS - tod + startMs;
      continue;
    }
    const activeLeftToday = endMs - tod;
    if (remainingActiveMs <= activeLeftToday) {
      cursor += remainingActiveMs;
      remainingActiveMs = 0;
      break;
    }
    remainingActiveMs -= activeLeftToday;
    cursor += activeLeftToday;
  }
  return Math.max(1_000, cursor - nowMs);
}
