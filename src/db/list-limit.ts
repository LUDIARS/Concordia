/**
 * 一覧 API / repo の取得上限を 1 箇所で丸めるヘルパ.
 *
 * 一覧系はクエリ由来の limit をそのまま SQL へ渡すため、 NaN / 0 / 負値 /
 * 巨大値を各所で個別に潰すと丸め方が食い違う。 上限規則はここだけに置く。
 */

/** 一覧系の既定取得件数。 */
export const DEFAULT_LIST_LIMIT = 200;
/** 1 リクエストで返す上限。 これ以上はページングで取る。 */
export const MAX_LIST_LIMIT = 500;

/**
 * 数値候補を 1 本の規則で数へ落とす。
 * `?limit=` のような空文字は「未指定」として扱う (Number("") = 0 で
 * 最小値へ丸まると、 指定していないのに 1 件しか返らない)。
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * limit 候補を 1..MAX_LIST_LIMIT に丸める。
 * 未指定・空文字・非数値は fallback (既定 DEFAULT_LIST_LIMIT) を返す。
 */
export function clampListLimit(value: unknown, fallback = DEFAULT_LIST_LIMIT): number {
  const n = toFiniteNumber(value);
  if (n === null) return fallback;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(n)));
}

/** offset 候補を 0 以上に丸める。 未指定・空文字・非数値は 0。 */
export function clampListOffset(value: unknown): number {
  const n = toFiniteNumber(value);
  if (n === null) return 0;
  return Math.max(0, Math.trunc(n));
}
