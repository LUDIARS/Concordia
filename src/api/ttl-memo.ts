/**
 * endpoint 内で共有する単一値の TTL メモを作る。
 *
 * HTTP キャッシュが query 単位で分かれても、呼び出し元に依存しない計算だけを短時間
 * 共有できる。時刻は注入可能にしてテストを決定的にする ([[RULE_CODE §16]])。
 */
export function createTtlMemo<T>(
  ttlMs: number,
  now: () => number = Date.now,
): (compute: () => T, forceRefresh?: boolean) => T {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive finite number");
  }

  let entry: { value: T; expiresAt: number } | null = null;
  return (compute, forceRefresh = false) => {
    const t = now();
    if (!forceRefresh && entry && t < entry.expiresAt) return entry.value;
    const value = compute();
    entry = { value, expiresAt: t + ttlMs };
    return value;
  };
}
