/**
 * 公開面へ出してよいかの判定と、公開用の形 (spec/feature/bug-bounty.md §8)。 純関数。
 *
 * 出すのは `public_issues` が 1 のプロジェクトの、採用済みの報告だけ。 機微な報告は反映済みのときだけ。
 * 判定できない (プロジェクト不明・公開設定を読めない) ものは出さない (CC-BOUNTY-INV-07)。
 * 公開用の形は §8 の項目だけを持ち、原文・受付口・プラットフォームの id・判定の内部理由を含めない。
 *
 * @implements SPEC-BOUNTY-PUBLIC
 */

import type { BountyReportStatus } from "./report-state.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:1c1b1b16 */
import augurContract_3c3cd048 from './public-view.contract.js'; /* augur-inject:contract-predicate:f5112055 */

/** 採用後の状態 (公開面に並べてよい段階)。 */
const ACCEPTED_STATES: readonly BountyReportStatus[] = ["accepted", "fix_pending", "fixing", "fix_submitted", "deployed"];

export interface BountyPublicationInput {
  /** プロジェクトの `public_issues`。 プロジェクトが分からない・読めないときは null。 */
  projectPublic: boolean | null;
  verdict: string | null;
  status: BountyReportStatus;
  sensitive: boolean;
}

export function decideBountyPublication(input: BountyPublicationInput): boolean {
  if (input.projectPublic !== true) return false;
  if (input.verdict !== "accepted") return false;
  if (!ACCEPTED_STATES.includes(input.status)) return false;
  if (input.sensitive && input.status !== "deployed") return false;
  return true;
}
// @ts-expect-error augur-inject
decideBountyPublication = contract(decideBountyPublication, { ...augurContract_3c3cd048, contractId: 'bounty-flow-C-5', mode: 'observe', sample: 1, where: 'src/bounty/public-view.ts:24', rule: 'contract-wrap', id: '3c3cd048' }); /* augur-inject:contract-wrap:3c3cd048 */

/** `GET /v1/bounty/public-reports` の 1 行。 §8 の一覧の項目だけ。 */
export interface BountyPublicReport {
  report_id: string;
  project: string;
  title: string;
  summary: string | null;
  severity: string | null;
  status: BountyReportStatus;
  reporter: string;
  reward_tokens: number | null;
  received_at: number;
  deployed_at: number | null;
  /** Actio のタスク (`source: concordia.bounty.v1`) の `sourceRef`。 報告 id と同じ。 */
  actio_source_ref: string;
}

export function toBountyPublicReport(row: {
  id: string;
  project_code: string;
  public_title: string | null;
  public_summary: string | null;
  severity: string | null;
  status: BountyReportStatus;
  received_at: number;
  deployed_at: number | null;
  reward_tokens: number | null;
}, reporter: string): BountyPublicReport {
  return {
    report_id: row.id,
    project: row.project_code,
    title: row.public_title ?? "(題名未設定)",
    summary: row.public_summary,
    severity: row.severity,
    status: row.status,
    reporter,
    reward_tokens: row.reward_tokens,
    received_at: row.received_at,
    deployed_at: row.deployed_at,
    actio_source_ref: row.id,
  };
}
