/**
 * Notion への要求の間隔 (spec/feature/patrol-chat.md「知識」)。 公開ページのクロール (notion-source-public.ts) が使う。
 *
 * - 要求の間を最低 334ms 空ける (平均 3 req/s)
 * Notion の公式 API と連携トークンは使わない (neco 指示 2026-10-18「Notion はトークンを使わず MCP とクロールで対応」)。
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:56548c81 */
import augurContract_126883c5 from './knowledge-notion.contract.js'; /* augur-inject:contract-predicate:b30305c2 */

/** 3 req/s。 */
export const NOTION_MIN_INTERVAL_MS = 334;

/** 直前の要求から最低間隔を空けるための待ち時間 (ms)。 純関数。 */
export function nextDelayMs(lastRequestAtMs: number | null, nowMs: number, minIntervalMs: number): number {
  if (lastRequestAtMs === null) return 0;
  return Math.max(0, lastRequestAtMs + minIntervalMs - nowMs);
}
// @ts-expect-error augur-inject
nextDelayMs = contract(nextDelayMs, { ...augurContract_126883c5, contractId: 'chat-knowledge-C-5', mode: 'observe', sample: 1, where: 'src/rules/knowledge-notion.ts:27', rule: 'contract-wrap', id: '126883c5' }); /* augur-inject:contract-wrap:126883c5 */

/** 要求の前に呼ぶと、 直前の要求から最低間隔があくまで待つ。 */
export interface RateGate {
  wait(): Promise<void>;
}

export function createRateGate(deps: { nowMs?: () => number; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number } = {}): RateGate {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const min = deps.minIntervalMs ?? NOTION_MIN_INTERVAL_MS;
  let last: number | null = null;
  return {
    wait: async () => {
      const delay = nextDelayMs(last, nowMs(), min);
      if (delay > 0) await sleep(delay);
      last = nowMs();
    },
  };
}
