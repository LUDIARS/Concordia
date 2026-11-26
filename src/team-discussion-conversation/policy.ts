import { contract } from './ontime-runtime.js'; /* augur-inject:import:035e908c */
import augurContract_9304c1cf from './quiet-period.contract.js'; /* augur-inject:contract-predicate:d07f9305 */
import augurContract_2e95f736 from './scope.contract.js'; /* augur-inject:contract-predicate:69c05445 */
import augurContract_a5f69249 from './decision.contract.js'; /* augur-inject:contract-predicate:3c1c9f47 */
import augurContract_973e7a04 from './checkpoint.contract.js'; /* augur-inject:contract-predicate:450fa6d8 */
// @spec チーム相談のファシリテーション
export const DISCUSSION_QUIET_MS = 5 * 60_000;
const MAX_SUMMARY_LENGTH = 16_000;

export function discussionIsQuiet(lastPostAt: number, now: number): boolean {
  return now - lastPostAt >= DISCUSSION_QUIET_MS;
}
// @ts-expect-error augur-inject
discussionIsQuiet = contract(discussionIsQuiet, { ...augurContract_9304c1cf, contractId: 'team-discussion-facilitator-C-201', mode: 'observe', sample: 1, where: 'src/team-discussion-conversation/policy.ts:5', rule: 'contract-wrap', id: '9304c1cf' }); /* augur-inject:contract-wrap:9304c1cf */

export function acceptsDiscussionPost(input: {
  human: boolean;
  publicChannel: boolean;
  ownedSurface: boolean;
  hasContent: boolean;
}): boolean {
  return input.human && input.publicChannel && input.ownedSurface && input.hasContent;
}
// @ts-expect-error augur-inject
acceptsDiscussionPost = contract(acceptsDiscussionPost, { ...augurContract_2e95f736, contractId: 'team-discussion-facilitator-C-202', mode: 'observe', sample: 1, where: 'src/team-discussion-conversation/policy.ts:9', rule: 'contract-wrap', id: '2e95f736' }); /* augur-inject:contract-wrap:2e95f736 */

export type DiscussionDecision =
  | { has_diff: false; summary: "" }
  | { has_diff: true; summary: string; current_summary: string };

function summaryText(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_SUMMARY_LENGTH ? value.trim() || null : null;
}

export function parseDiscussionDecision(output: string, completed: boolean): DiscussionDecision | null {
  if (!completed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { has_diff, summary, current_summary } = raw as Record<string, unknown>;
  if (has_diff === false && typeof summary === "string" && !summary.trim()) return { has_diff: false, summary: "" };
  const delta = summaryText(summary);
  const current = summaryText(current_summary);
  return has_diff === true && delta && current ? { has_diff: true, summary: delta, current_summary: current } : null;
}
// @ts-expect-error augur-inject
parseDiscussionDecision = contract(parseDiscussionDecision, { ...augurContract_a5f69249, contractId: 'team-discussion-facilitator-C-203', mode: 'observe', sample: 1, where: 'src/team-discussion-conversation/policy.ts:26', rule: 'contract-wrap', id: 'a5f69249' }); /* augur-inject:contract-wrap:a5f69249 */

export interface DiscussionReceipt {
  id: string;
  last: boolean;
}

export function discussionCheckpoint(through: string, summary: string, receipt: DiscussionReceipt | null):
  { through: string; summary: string } | null {
  return receipt?.last && receipt.id ? { through, summary } : null;
}
// @ts-expect-error augur-inject
discussionCheckpoint = contract(discussionCheckpoint, { ...augurContract_973e7a04, contractId: 'team-discussion-facilitator-C-204', mode: 'observe', sample: 1, where: 'src/team-discussion-conversation/policy.ts:47', rule: 'contract-wrap', id: '973e7a04' }); /* augur-inject:contract-wrap:973e7a04 */
