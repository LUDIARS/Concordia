/**
 * 仕分けの結果の検証 (spec/feature/bug-bounty.md §5)。 純関数。
 *
 * 結果は入口で検証する: 列挙値・長さ・`duplicate_of` の実在と同一プロジェクト・推定したプロジェクトの
 * 登録と会社の範囲。 不正な結果は保存しない (呼び出し側が失敗として記録する)。 重複先がさらに重複なら
 * 根の報告へ付け替える。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 */

import type { BountySeverity, BountyVerdict } from "../db/bounty-reports-repo.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:38c8c5ca */
import augurContract_4ba21456 from './triage-result.contract.js'; /* augur-inject:contract-predicate:947d96fd */

export const BOUNTY_VERDICTS: readonly BountyVerdict[] = ["accepted", "duplicate", "rejected", "needs_info"];
export const BOUNTY_SEVERITIES: readonly BountySeverity[] = ["s1", "s2", "s3", "s4"];
export const MAX_PUBLIC_TITLE_CHARS = 120;
export const MAX_PUBLIC_SUMMARY_CHARS = 1000;
export const MAX_VERDICT_REASON_CHARS = 1000;
/** 重複先を辿る上限 (循環の防止)。 */
const MAX_DUPLICATE_DEPTH = 20;

export interface BountyTriageLookupRow {
  id: string;
  project_code: string | null;
  duplicate_of: string | null;
}

export interface BountyTriageValidationInput {
  /** 仕分けセッションが返した生の値。 */
  raw: unknown;
  report: { id: string; project_code: string | null };
  find(id: string): BountyTriageLookupRow | null;
  /** project registry のコード。 */
  registeredProjects: readonly string[];
  /** 会社の関係プロジェクト。 本社は null (制限なし)。 */
  companyProjects: readonly string[] | null;
}

export interface BountyTriageResult {
  verdict: BountyVerdict;
  severity: BountySeverity | null;
  duplicateOf: string | null;
  sensitive: boolean;
  selfInflicted: boolean;
  hotfixEligible: boolean;
  /** 確定した対象プロジェクト (受付時のもの、または推定)。 */
  project: string | null;
  publicTitle: string | null;
  publicSummary: string | null;
  reason: string;
}

export type BountyTriageValidation = { ok: true; value: BountyTriageResult } | { ok: false; errors: string[] };

function text(value: unknown, max: number): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false };
  return { ok: true, value: trimmed || null };
}

function flag(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === "boolean" ? value : null;
}

/** 重複先を根まで辿る。 循環・欠落・深すぎるときは null。 */
export function resolveDuplicateRoot(id: string, find: (id: string) => BountyTriageLookupRow | null): BountyTriageLookupRow | null {
  const seen = new Set<string>();
  let current = find(id);
  for (let depth = 0; current && depth < MAX_DUPLICATE_DEPTH; depth += 1) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    if (!current.duplicate_of) return current;
    current = find(current.duplicate_of);
  }
  return null;
}

export function validateBountyTriageResult(input: BountyTriageValidationInput): BountyTriageValidation {
  const errors: string[] = [];
  const raw = (input.raw && typeof input.raw === "object" ? input.raw : {}) as Record<string, unknown>;
  const verdict = BOUNTY_VERDICTS.find((value) => value === raw.verdict) ?? null;
  if (!verdict) errors.push("verdict");
  const severity = raw.severity === undefined || raw.severity === null
    ? null
    : BOUNTY_SEVERITIES.find((value) => value === raw.severity) ?? undefined;
  if (severity === undefined) errors.push("severity");
  if (verdict === "accepted" && !severity) errors.push("severity_required");
  const sensitive = flag(raw.sensitive, true);
  const selfInflicted = flag(raw.self_inflicted, false);
  const hotfixEligible = flag(raw.hotfix_eligible, false);
  if (sensitive === null) errors.push("sensitive");
  if (selfInflicted === null) errors.push("self_inflicted");
  if (hotfixEligible === null) errors.push("hotfix_eligible");
  const title = text(raw.public_title, MAX_PUBLIC_TITLE_CHARS);
  const summary = text(raw.public_summary, MAX_PUBLIC_SUMMARY_CHARS);
  const reason = text(raw.reason, MAX_VERDICT_REASON_CHARS);
  if (!title.ok) errors.push("public_title");
  if (!summary.ok) errors.push("public_summary");
  if (!reason.ok || !reason.value) errors.push("reason");
  if (verdict === "accepted" && title.ok && !title.value) errors.push("public_title_required");

  // 対象プロジェクト: 受付時に決まっていればそれ。 不明なら推定 (登録済み・会社の範囲内) を受ける。
  let project = input.report.project_code;
  const estimated = raw.project === undefined || raw.project === null ? null : raw.project;
  if (project === null && estimated !== null) {
    if (typeof estimated !== "string" || !input.registeredProjects.includes(estimated)) errors.push("project");
    else if (input.companyProjects !== null && !input.companyProjects.includes(estimated)) errors.push("project_outside_company_scope");
    else project = estimated;
  }

  // 採用は Actio のタスクを作るので、対象プロジェクトが決まっていなければならない。
  if (verdict === "accepted" && project === null) errors.push("project_required");

  let duplicateOf: string | null = null;
  if (verdict === "duplicate") {
    const target = typeof raw.duplicate_of === "string" ? raw.duplicate_of.trim() : "";
    const root = target && target !== input.report.id ? resolveDuplicateRoot(target, input.find) : null;
    if (!root || root.id === input.report.id) errors.push("duplicate_of");
    else if (root.project_code !== project) errors.push("duplicate_of_project");
    else duplicateOf = root.id;
  } else if (raw.duplicate_of !== undefined && raw.duplicate_of !== null) {
    errors.push("duplicate_of_unexpected");
  }

  if (errors.length > 0 || !verdict) return { ok: false, errors };
  return {
    ok: true,
    value: {
      verdict,
      severity: severity ?? null,
      duplicateOf,
      sensitive: sensitive!,
      selfInflicted: selfInflicted!,
      hotfixEligible: verdict === "accepted" && hotfixEligible!,
      project,
      publicTitle: title.ok ? title.value : null,
      publicSummary: summary.ok ? summary.value : null,
      reason: reason.ok && reason.value ? reason.value : "",
    },
  };
}
// @ts-expect-error augur-inject
validateBountyTriageResult = contract(validateBountyTriageResult, { ...augurContract_4ba21456, contractId: 'bounty-flow-C-2', mode: 'observe', sample: 1, where: 'src/bounty/triage-result.ts:80', rule: 'contract-wrap', id: '4ba21456' }); /* augur-inject:contract-wrap:4ba21456 */
