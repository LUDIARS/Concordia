import { contract } from './ontime-runtime.js'; /* augur-inject:import:e07b08e8 */
import augurContract_002caf2a from './push-limits.contract.js'; /* augur-inject:contract-predicate:78c712d5 */
/**
 * LINE push の送信上限と requestId の記憶 (spec/feature/line-webhook-relay.md §LINE push の受け口)。
 *
 * 上限は 1 サービスあたり 1 分 10 件。 requestId は 24 時間覚えて、 同じ requestId には送らずに前回の
 * 結果を返す。 どちらもプロセス内のメモリに持つ (再起動で忘れても LINE 側の Retry-Key で二重送信にならない)。
 *
 * @implements spec/feature/line-webhook-relay.md — LINE push の受け口
 */

export const PUSH_RATE_LIMIT = 10;
export const PUSH_RATE_WINDOW_MS = 60_000;
export const PUSH_REQUEST_MEMO_MS = 24 * 60 * 60 * 1000;

export interface PushSlot {
  allowed: boolean;
  /** 直近 1 分の送信時刻 (許可したときは now を含む)。 */
  history: number[];
}

/** 直近 1 分の送信が上限未満なら枠を 1 つ取る。 */
export function takePushSlot(history: readonly number[], now: number): PushSlot {
  const recent = history.filter((at) => now - at < PUSH_RATE_WINDOW_MS);
  if (recent.length >= PUSH_RATE_LIMIT) return { allowed: false, history: recent };
  return { allowed: true, history: [...recent, now] };
}
// @ts-expect-error augur-inject
takePushSlot = contract(takePushSlot, { ...augurContract_002caf2a, contractId: 'line-wh-C-18', mode: 'observe', sample: 1, where: 'src/line-webhook/push-limits.ts:21', rule: 'contract-wrap', id: '002caf2a' }); /* augur-inject:contract-wrap:002caf2a */

export interface PushResult {
  sent: number;
  failed: number;
}

/** サービスごとの送信枠と requestId ごとの結果。 同じ requestId の同時の要求は同じ送信を待つ。 */
export class PushLedger {
  private readonly slots = new Map<string, number[]>();
  private readonly results = new Map<string, { at: number; result: Promise<PushResult> }>();

  /** 24 時間以内に同じ requestId があればその結果。 */
  recall(key: string, now: number): Promise<PushResult> | null {
    this.prune(now);
    return this.results.get(key)?.result ?? null;
  }

  remember(key: string, now: number, result: Promise<PushResult>): void {
    this.results.set(key, { at: now, result });
  }

  take(service: string, now: number): boolean {
    const slot = takePushSlot(this.slots.get(service) ?? [], now);
    this.slots.set(service, slot.history);
    return slot.allowed;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.results) {
      if (now - entry.at >= PUSH_REQUEST_MEMO_MS) this.results.delete(key);
    }
  }
}
