/**
 * 会社 (本社 / 子会社) ごとの同時セッション上限 (spec/feature/usage-budgets.md §9)。
 *
 * 数えるのは `sessions.status = 'active'` の行。 会社は metadata.subsidiary_id で決まり、
 * 無ければ本社。 委託で起動した子セッションも同じ会社の 1 セッションとして数える
 * (起動したセッションは委託でも人の起動でも同じだけ動くため)。 上限 0 は「上限なし」。
 *
 * 純関数だけを置く。 リポジトリや設定から値を集めるのは company-session-cap-service.ts。
 */

import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:11ae4dac */
import augurContract_c88fb49d from './company-session-cap-decision.contract.js'; /* augur-inject:contract-predicate:c560916e */
import augurContract_ebf5afd4 from './company-session-count.contract.js'; /* augur-inject:contract-predicate:2c378aec */
import augurContract_e651ab5d from './company-session-refusal.contract.js'; /* augur-inject:contract-predicate:35b5fce7 */

/** 起動を断ったときの API エラーの接頭辞。 チャット側はこれを見て本人向けの文面を取り出す。 */
export const SESSION_CAP_ERROR_PREFIX = "session_cap_reached: ";

/** 本社の同時セッション上限の既定値 (2026-10-03 neco 指示「本社は 30 で止める」)。 */
export const DEFAULT_HEAD_OFFICE_MAX_SESSIONS = 30;

/** 1 会社の稼働数と上限。 */
export interface CompanySessionCapRow {
  /** 子会社 id。 本社は null。 */
  subsidiary_id: string | null;
  name: string;
  /** 今動いているセッション数。 */
  active: number;
  /** 上限。 0 は上限なし。 */
  max: number;
  /** 上限に達しているか (max>0 かつ active>=max)。 */
  reached: boolean;
}

export type CompanySessionCapDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/** active セッションを会社ごとに数える。 キーは子会社 id、 本社は null。 */
export function countActiveSessionsByCompany(
  sessions: ReadonlyArray<{ metadata: string | null }>,
): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const session of sessions) {
    const company = readSubsidiaryId(session.metadata);
    counts.set(company, (counts.get(company) ?? 0) + 1);
  }
  return counts;
}
// @ts-expect-error augur-inject
countActiveSessionsByCompany = contract(countActiveSessionsByCompany, { ...augurContract_ebf5afd4, contractId: 'cap-C-2', mode: 'observe', sample: 1, where: 'src/cost/company-session-cap.ts:37', rule: 'contract-wrap', id: 'ebf5afd4' }); /* augur-inject:contract-wrap:ebf5afd4 */

/** 上限の値を 0 以上の整数へ寄せる。 数でない・負は 0 (上限なし)。 */
export function normalizeSessionCap(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function buildCompanySessionCapRow(input: {
  subsidiaryId: string | null;
  name: string;
  active: number;
  max: number;
}): CompanySessionCapRow {
  const max = normalizeSessionCap(input.max);
  const active = Math.max(0, Math.floor(input.active));
  return { subsidiary_id: input.subsidiaryId, name: input.name, active, max, reached: max > 0 && active >= max };
}

/** 新しい起動を 1 本足してよいか。 上限以上なら理由を返す。 */
export function decideCompanySessionCap(row: CompanySessionCapRow): CompanySessionCapDecision {
  if (!row.reached) return { allowed: true };
  return { allowed: false, reason: sessionCapRefusalMessage(row.name, row.max) };
}
// @ts-expect-error augur-inject
decideCompanySessionCap = contract(decideCompanySessionCap, { ...augurContract_c88fb49d, contractId: 'cap-C-1', mode: 'observe', sample: 1, where: 'src/cost/company-session-cap.ts:66', rule: 'contract-wrap', id: 'c88fb49d' }); /* augur-inject:contract-wrap:c88fb49d */

/** 起動した人に返す文面。 */
export function sessionCapRefusalMessage(companyName: string, max: number): string {
  return `${companyName}のセッション上限 (${max}) に達しています。動いているセッションが終わってから起動してください。`;
}

/** API エラー文字列から本人向けの文面を取り出す。 上限の拒否でなければ null。 */
export function sessionCapRefusalText(error: string): string | null {
  const at = error.indexOf(SESSION_CAP_ERROR_PREFIX);
  return at >= 0 ? error.slice(at + SESSION_CAP_ERROR_PREFIX.length) : null;
}
// @ts-expect-error augur-inject
sessionCapRefusalText = contract(sessionCapRefusalText, { ...augurContract_e651ab5d, contractId: 'cap-C-3', mode: 'observe', sample: 1, where: 'src/cost/company-session-cap.ts:77', rule: 'contract-wrap', id: 'e651ab5d' }); /* augur-inject:contract-wrap:e651ab5d */
