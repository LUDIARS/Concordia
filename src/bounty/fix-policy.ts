/**
 * 修正の判断 (spec/feature/bug-bounty.md §6)。 純関数。
 *
 * hotfix の条件: 判定が採用、`hotfix_eligible`、対象プロジェクトの Revisor workflow が `revisor`、
 * Actio のタスクが作成済み、修正待ち (`fix_pending`)、そのプロジェクトの当日の起動数が上限未満。
 * 失敗・停止した hotfix は修正待ちへ戻すが、同じ報告を自動で起動し直さない (CC-INV-03) ので、
 * 起動済みの報告 (`hotfixStartedAt` あり) は条件を満たさない。
 *
 * @implements SPEC-BOUNTY-HOTFIX
 */

import { DEFAULT_BOUNTY_HOTFIX_DAILY_LIMIT } from "./hotfix-settings.js";
import type { BountyReportStatus } from "./report-state.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:1517a214 */
import augurContract_3756cd44 from './fix-policy.contract.js'; /* augur-inject:contract-predicate:b491d3ee */

export { DEFAULT_BOUNTY_HOTFIX_DAILY_LIMIT };

export type BountyHotfixDenial =
  | "not_accepted"
  | "not_eligible"
  | "not_revisor_workflow"
  | "task_missing"
  | "not_fix_pending"
  | "already_started"
  | "daily_limit";

export interface BountyHotfixInput {
  status: BountyReportStatus;
  verdict: string | null;
  hotfixEligible: boolean;
  revisorWorkflow: string | null;
  actioTaskRef: string | null;
  hotfixStartedAt: number | null;
  hotfixesToday: number;
  dailyLimit: number;
}

export function decideBountyHotfix(input: BountyHotfixInput): { ok: true } | { ok: false; denial: BountyHotfixDenial } {
  if (input.verdict !== "accepted") return { ok: false, denial: "not_accepted" };
  if (!input.hotfixEligible) return { ok: false, denial: "not_eligible" };
  if (input.revisorWorkflow !== "revisor") return { ok: false, denial: "not_revisor_workflow" };
  if (!input.actioTaskRef) return { ok: false, denial: "task_missing" };
  if (input.status !== "fix_pending") return { ok: false, denial: "not_fix_pending" };
  if (input.hotfixStartedAt !== null) return { ok: false, denial: "already_started" };
  if (!(input.hotfixesToday < input.dailyLimit)) return { ok: false, denial: "daily_limit" };
  return { ok: true };
}
// @ts-expect-error augur-inject
decideBountyHotfix = contract(decideBountyHotfix, { ...augurContract_3756cd44, contractId: 'bounty-flow-C-3', mode: 'observe', sample: 1, where: 'src/bounty/fix-policy.ts:37', rule: 'contract-wrap', id: '3756cd44' }); /* augur-inject:contract-wrap:3756cd44 */

/** 設定値の解釈。 不正・負の値は既定値に戻す。 */
export function parseBountyHotfixDailyLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") return DEFAULT_BOUNTY_HOTFIX_DAILY_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_BOUNTY_HOTFIX_DAILY_LIMIT;
}

/** hotfix のブランチ `fix/bounty-<報告 id の短縮>`。 */
export function bountyFixBranch(reportId: string): string {
  const short = reportId.replace(/^br_/u, "").replace(/[^A-Za-z0-9]/gu, "").slice(0, 10).toLowerCase();
  return `fix/bounty-${short || "report"}`;
}

/** 当日 (ローカル時刻の 0 時) の始まり。 */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
