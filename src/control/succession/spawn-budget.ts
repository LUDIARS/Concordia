/**
 * 自動経路の spawn 上限 (直近 windowSec 秒に limit 件まで)。
 *
 * 大量同時 spawn で Excubitor が落ちた事故の再発防止。 自動引き継ぎとリポ担当で 1 つを共有する。
 * 上限を超えた分は呼び出し側が「次の機会」に回す。
 *
 * @implements spec/feature/session-auto-succession.md §3.2
 */

export interface SpawnBudget {
  /** 1 枠取れたら true (取った時刻を記録する)。 */
  tryTake(): boolean;
}

export const DEFAULT_SPAWN_LIMIT = 2;
export const DEFAULT_SPAWN_WINDOW_SEC = 60;

export function createSpawnBudget(
  now: () => number,
  limit = DEFAULT_SPAWN_LIMIT,
  windowSec = DEFAULT_SPAWN_WINDOW_SEC,
): SpawnBudget {
  const taken: number[] = [];
  return {
    tryTake() {
      const current = now();
      while (taken.length > 0 && current - taken[0] >= windowSec) taken.shift();
      if (taken.length >= limit) return false;
      taken.push(current);
      return true;
    },
  };
}
