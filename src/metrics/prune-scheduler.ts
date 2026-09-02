/** 一定間隔で同期 prune 処理を実行する。最初の呼び出しは必ず実行する。 */
export function createPruneScheduler(
  intervalMs: number,
  now: () => number = Date.now,
): (prune: (currentTimeMs: number) => void) => boolean {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number");
  }

  let lastPruneAt: number | null = null;
  return (prune) => {
    const currentTime = now();
    if (lastPruneAt !== null && currentTime - lastPruneAt < intervalMs) return false;
    prune(currentTime);
    // prune が失敗した場合は更新されず、次回呼び出しで再試行する。
    lastPruneAt = currentTime;
    return true;
  };
}
