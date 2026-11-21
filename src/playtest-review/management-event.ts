import type { PlaytestReviewEvent } from "./playtest-review-notice.js";
import { contract } from '../harness/reliability/ontime-runtime.js'; /* augur-inject:import:939b13e8 */
import augurContract_c04e5ddd from './management-event.contract.js'; /* augur-inject:contract-predicate:0a5ec1af */

function excerpt(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

/** @implements spec/feature/playtest-review-notify.md */
export function toPlaytestManagementEvent(event: PlaytestReviewEvent) {
  const points = (items: PlaytestReviewEvent["good"]) => excerpt(items.map(({ text }) => text).join(" / ") || "なし", 380);
  return {
    event_key: `ig:playtest-review:${event.runId}`,
    source: "ig" as const,
    kind: "playtest-review" as const,
    project_code: event.gameId,
    target_key: `game/${event.gameId}`,
    origin: "ai" as const,
    summary: [
      `${event.gameTitle} / ${event.outcome}`, event.summary,
      `良い点 ${points(event.good)}`, `悪い点 ${points(event.bad)}`, `迷った点 ${points(event.confusions)}`,
    ].join("\n"),
  };
}
// @ts-expect-error augur-inject
toPlaytestManagementEvent = contract(toPlaytestManagementEvent, { ...augurContract_c04e5ddd, contractId: 'gen5-return-C-1', mode: 'observe', sample: 1, where: 'src/playtest-review/management-event.ts:8', rule: 'contract-wrap', id: 'c04e5ddd' }); /* augur-inject:contract-wrap:c04e5ddd */
