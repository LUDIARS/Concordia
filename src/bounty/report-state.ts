import { contract } from './ontime-runtime.js'; /* augur-inject:import:66b5feea */
import augurContract_cd70c067 from './report-state.contract.js'; /* augur-inject:contract-predicate:0aff9a30 */
/**
 * バグ報告の状態と遷移の可否 (spec/feature/bug-bounty.md §9)。 純関数だけを持つ。
 *
 * 台帳 (bounty_reports) はここで許可された遷移だけを状態の CAS で書く。 `deployed` は反映確認
 * (デプロイの code / hash、 または権限者の根拠) があるときだけで、 PR の提出・審査通過・マージでは
 * 遷移させない (CC-BOUNTY-INV-09)。
 *
 * @implements SPEC-BOUNTY-INTAKE
 */

export const BOUNTY_REPORT_STATUSES = [
  "received",
  "needs_info",
  "rejected",
  "duplicate",
  "accepted",
  "fix_pending",
  "fixing",
  "fix_submitted",
  "deployed",
  "withdrawn",
] as const;

export type BountyReportStatus = (typeof BOUNTY_REPORT_STATUSES)[number];

/** 反映確認の証拠。 デプロイ通知由来か、 権限者が根拠付きで閉じたか。 */
export type BountyDeploymentEvidence =
  | { kind: "deploy"; code: string; hash: string }
  | { kind: "manual"; reason: string; actor: string };

export type BountyTransitionDenial = "transition_not_allowed" | "deployment_evidence_required";

export type BountyTransitionResult = { ok: true } | { ok: false; denial: BountyTransitionDenial };

/**
 * 遷移の表。 rejected / duplicate から accepted へ戻るのは再審と権限者の変更 (CC-BOUNTY-INV-08)、
 * 採用後に rejected / duplicate へ移るのは判定が覆ったとき。 deployed と withdrawn は終端。
 */
const TRANSITIONS: Readonly<Record<BountyReportStatus, readonly BountyReportStatus[]>> = {
  received: ["needs_info", "rejected", "duplicate", "accepted", "withdrawn"],
  needs_info: ["received", "rejected", "duplicate", "accepted", "withdrawn"],
  rejected: ["accepted"],
  duplicate: ["accepted", "rejected"],
  accepted: ["fix_pending", "rejected", "duplicate"],
  fix_pending: ["fixing", "fix_submitted", "deployed", "rejected", "duplicate"],
  fixing: ["fix_pending", "fix_submitted", "deployed", "rejected", "duplicate"],
  fix_submitted: ["fix_pending", "deployed", "rejected", "duplicate"],
  deployed: [],
  withdrawn: [],
};

export function isBountyReportStatus(value: unknown): value is BountyReportStatus {
  return typeof value === "string" && (BOUNTY_REPORT_STATUSES as readonly string[]).includes(value);
}

/** 採用前 (仕分けがまだ採否を出していない) か。 取り下げと追記はこの間だけ。 */
export function isBeforeAcceptance(status: BountyReportStatus): boolean {
  return status === "received" || status === "needs_info";
}

export function decideBountyTransition(input: {
  from: BountyReportStatus;
  to: BountyReportStatus;
  deploymentEvidence?: BountyDeploymentEvidence | null;
}): BountyTransitionResult {
  if (!TRANSITIONS[input.from]?.includes(input.to)) return { ok: false, denial: "transition_not_allowed" };
  if (input.to === "deployed" && !hasDeploymentEvidence(input.deploymentEvidence)) {
    return { ok: false, denial: "deployment_evidence_required" };
  }
  return { ok: true };
}
// @ts-expect-error augur-inject
decideBountyTransition = contract(decideBountyTransition, { ...augurContract_cd70c067, contractId: 'bounty-intake-C-1', mode: 'observe', sample: 1, where: 'src/bounty/report-state.ts:61', rule: 'contract-wrap', id: 'cd70c067' }); /* augur-inject:contract-wrap:cd70c067 */

function hasDeploymentEvidence(evidence: BountyDeploymentEvidence | null | undefined): boolean {
  if (!evidence) return false;
  if (evidence.kind === "deploy") return filled(evidence.code) && filled(evidence.hash);
  if (evidence.kind === "manual") return filled(evidence.reason) && filled(evidence.actor);
  return false;
}

function filled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
