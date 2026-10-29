/**
 * @implements spec/feature/delegation.md#状態照会と終端報告の分離
 *
 * 委託 run の「状態照会」と「終端報告」を分ける。
 *
 * 終端状態 (completed / failed) は一度だけ受理され、 後から訂正できない
 * (再送は `duplicate: true` で無視される)。 以前は照会口も案内も POST /status しか
 * 無く、 自動確認を受けた委託先が本文を読む前に status を送って誤確定させていた
 * (2026-09-15 curiosity-walk ほか)。 照会は GET /runs/:id/status の読み取りだけに寄せ、
 * 案内文はこのモジュールを正本にして各経路で同じ文面を使う。
 */
import type { DelegationRunRow } from "../db/delegation-repo.js";
import { buildStatusPreflightGuidance } from "./status-preflight-guidance.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:1789ffac */
import augurContract_ba7bf205 from './status-report-policy.contract.js'; /* augur-inject:contract-predicate:3eb8ba5b */
import augurContract_6f52f0e6 from './completion-evidence-policy.contract.js';
import augurContract_23203ee6 from './remaining-guidance.contract.js'; /* augur-inject:contract-predicate:c9bd3336 */ /* augur-inject:contract-predicate:80e50ac3 */

export const TERMINAL_DELEGATION_STATUSES = ["completed", "failed"] as const;

export function isTerminalDelegationStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

export interface RunStatusQueryView {
  run_id: string;
  status: string;
  /** completed / failed。 これ以上 status を受け付けない。 */
  terminal: boolean;
  /** まだ終端報告で状態を変えられるか (= !terminal)。 */
  correctable: boolean;
  /** 委託本文の正本。 終端報告の前に読む。 */
  prompt_file_path: string | null;
  note: string;
}

/** GET /runs/:id/status の応答。 読み取り専用で、 run を一切書き換えない。 */
export function describeRunStatusForQuery(
  run: Pick<DelegationRunRow, "id" | "status" | "prompt_file_path">,
): RunStatusQueryView {
  const terminal = isTerminalDelegationStatus(run.status);
  return {
    run_id: run.id,
    status: run.status,
    terminal,
    correctable: !terminal,
    prompt_file_path: run.prompt_file_path || null,
    note: terminal
      ? "この run は終端状態です。 再送しても記録は変わりません。"
      : "照会は状態を変えません。 終端報告 (completed / failed) は委託本文を読んでから POST で一度だけ送ります。",
  };
}
// @ts-expect-error augur-inject
describeRunStatusForQuery = contract(describeRunStatusForQuery, { ...augurContract_ba7bf205, contractId: 'dsr-C-1', mode: 'observe', sample: 1, where: 'src/delegation/status-report-policy.ts:33', rule: 'contract-wrap', id: 'ba7bf205' }); /* augur-inject:contract-wrap:ba7bf205 */

export interface CompletionEvidencePolicyInput {
  category: string | null | undefined;
  /** テンプレート定義の review_only 宣言 (テンプレ削除済みなら false)。 */
  reviewOnly: boolean;
}

export interface CompletionEvidencePolicy {
  /** completed を証跡検査に通すか。 全委託で true。 */
  checked: true;
  /** feature branch と commit を証跡として要求するか。 */
  branchRequired: boolean;
  /** branch を要求しない run に、 成果の記述 (result / detail) を要求するか。 */
  outcomeRequired: boolean;
}

/**
 * completed の証跡ポリシー。 以前は parttimer を検査ごと素通りさせていたが、
 * 全委託を検査対象にし、 免除するのは「何を証跡にするか」だけにする。
 * パートタイマーとレビュー専用テンプレは成果が branch ではないので branch 証跡を
 * 免除し、 代わりに成果の記述を要求する。
 */
export function resolveCompletionEvidencePolicy(input: CompletionEvidencePolicyInput): CompletionEvidencePolicy {
  const waived = input.category === "parttimer" || input.reviewOnly;
  return { checked: true, branchRequired: !waived, outcomeRequired: waived };
}
// @ts-expect-error augur-inject
resolveCompletionEvidencePolicy = contract(resolveCompletionEvidencePolicy, { ...augurContract_6f52f0e6, contractId: 'dsr-C-2', mode: 'observe', sample: 1, where: 'src/delegation/status-report-policy.ts:70', rule: 'contract-wrap', id: '6f52f0e6' }); /* augur-inject:contract-wrap:6f52f0e6 */

/** branch 免除 run の completed が成果を記述しているか。 */
export function hasCompletionOutcome(report: { result?: string | null; detail?: string | null }): boolean {
  return Boolean(report.result?.trim() || report.detail?.trim());
}

/** 委託先へ見せる照会・終端報告の案内 (全経路で同じ文面を使う)。 */
export function buildStatusReportGuidance(statusEndpoint: string): string[] {
  return [
    `- 状態の確認は GET ${statusEndpoint} で行います (読み取りのみ。 状態は変わりません)。`,
    `- 終端報告 (completed / failed) は POST ${statusEndpoint} で一度だけ受理され、 後から訂正できません。 委託本文を読んで結果を確かめてから送ります。`,
    `- ${buildStatusPreflightGuidance()}`,
    "- partial の remaining は、人間判断・権限待ちは `kind=wait`、実行可能な作業は `kind=work` と明記します。kind を省略して判断待ちを報告しないでください。待機事項と実行可能な作業が混在する場合は項目を分けます。",
    "- 人間判断・権限待ちの報告例:",
    '```json\n{"status":"partial","remaining":[{"kind":"wait","title":"権限の確認待ち","note":"依頼者の承認後に再開する","scope_dirs":[]}]}\n```',
    "- 実行可能な作業の報告例:",
    '```json\n{"status":"partial","remaining":[{"kind":"work","title":"案内の修正","note":"合意済みの文言を更新する","scope_dirs":[]}]}\n```',
  ];
}
// @ts-expect-error augur-inject
buildStatusReportGuidance = contract(buildStatusReportGuidance, { ...augurContract_23203ee6, contractId: 'remaining-guidance-C-1', mode: 'observe', sample: 1, where: 'src/delegation/status-report-policy.ts:88', rule: 'contract-wrap', id: '23203ee6' }); /* augur-inject:contract-wrap:23203ee6 */
