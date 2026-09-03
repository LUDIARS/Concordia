// @implements spec/feature/runtime-function-metrics.md — イベントループ停止時の被疑者記録
import { redactSecrets } from "./redact-secrets.js";

/**
 * 処理中 HTTP リクエストの台帳。
 *
 * 責務は 1 つ: 「いま何本のリクエストが、 いつから走っているか」 を保持する。
 *
 * 背景: イベントループが止まったとき、 停止そのものは
 * `event loop stalled` として lag と handle 数だけ残る。 しかし **誰が止めたか**は
 * 残らない。 止めている間はログも書けないので、 事後にはログの空白から推測するしか
 * なくなる (2026-07-26 の 14 秒停止、 2026-09-03 の 12.3 秒停止とも、 停止の直前行と
 * 明けた直後の行を突き合わせて推測した)。 発生頻度が低く CPU プロファイルでも
 * 捕まらないので、 停止検知時に未完了だったリクエストを相関材料として残す。
 *
 * 台帳は因果を証明しない。 timer / 定期ジョブが event loop を止めて HTTP リクエストを
 * 巻き込むこともあり、 同期 HTTP handler が監視 timer の発火前に完了して台帳から消える
 * こともある。 空かどうかを含め、 前後の観測と組み合わせて切り分ける。
 *
 * module singleton なのは、 記録側 (HTTP middleware) と読み出し側 (停止監視) が
 * 別々に組み立てられるため。 `listHaltedLoops` と同じ形に揃えている。
 */

/** 停止時に残す最大件数。 全部出すとログ 1 行が肥大するので、 古い順に絞る。 */
const DEFAULT_SNAPSHOT_LIMIT = 10;
/** 不正・異常に長い request target で診断ログと台帳メモリを膨らませない。 */
const MAX_RECORDED_PATH_LENGTH = 512;

export interface InFlightRequest {
  method: string;
  path: string;
  /** スナップショット時点での経過時間 (ms)。 */
  ageMs: number;
}

interface Entry {
  method: string;
  path: string;
  startedAt: number;
}

/** `begin` が返す不透明なハンドル。 `end` にそのまま渡す。 */
export type InFlightHandle = object;

const entries = new Map<InFlightHandle, Entry>();

/**
 * リクエストの開始を記録する。 戻り値のハンドルを必ず {@link endRequest} へ渡すこと
 * (finally で呼ぶ)。 呼ばないと台帳に残り続ける。
 *
 * @implements spec/feature/runtime-function-metrics.md — イベントループ停止時の被疑者記録
 */
export function beginRequest(method: string, path: string, startedAt: number = Date.now()): InFlightHandle {
  const handle: InFlightHandle = {};
  const redactedPath = redactSecrets(path);
  const recordedPath = redactedPath.length <= MAX_RECORDED_PATH_LENGTH
    ? redactedPath
    : `${redactedPath.slice(0, MAX_RECORDED_PATH_LENGTH - 1)}…`;
  entries.set(handle, { method, path: recordedPath, startedAt });
  return handle;
}

/**
 * リクエストの終了を記録する。 未知のハンドルは無視する (二重解放を許容)。
 *
 * @implements spec/feature/runtime-function-metrics.md — イベントループ停止時の被疑者記録
 */
export function endRequest(handle: InFlightHandle): void {
  entries.delete(handle);
}

/**
 * 現在処理中のリクエストを、 経過時間の長い順に返す。
 * 長時間処理から確認できるよう、 最も古いリクエストを先頭にする。
 *
 * @implements spec/feature/runtime-function-metrics.md — イベントループ停止時の被疑者記録
 */
export function snapshotInFlightRequests(
  now: number = Date.now(),
  limit: number = DEFAULT_SNAPSHOT_LIMIT,
): InFlightRequest[] {
  const rows: InFlightRequest[] = [];
  for (const entry of entries.values()) {
    rows.push({ method: entry.method, path: entry.path, ageMs: now - entry.startedAt });
  }
  rows.sort((a, b) => b.ageMs - a.ageMs);
  return rows.slice(0, Math.max(0, limit));
}

/**
 * 台帳の件数。 スナップショットを絞った場合に「全部で何本か」を添えるのに使う。
 *
 * @implements spec/feature/runtime-function-metrics.md — イベントループ停止時の被疑者記録
 */
export function inFlightRequestCount(): number {
  return entries.size;
}

/**
 * テスト用。 台帳を空にする。
 *
 * @implements spec/feature/runtime-function-metrics.md — イベントループ停止時の被疑者記録
 */
export function resetInFlightRequests(): void {
  entries.clear();
}
