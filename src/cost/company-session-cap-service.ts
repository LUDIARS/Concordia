/**
 * 会社ごとの同時セッション上限を、 実データ (active セッション・本社設定・子会社行) から
 * 引いて判定する (spec/feature/usage-budgets.md §9)。
 *
 * 起動の入口 (admin spawn・/v1/spawn・委託 invoke) が `check` で断り、 コスト画面が
 * `report` で「稼働数 / 上限」を出す。 判定そのものは company-session-cap.ts の純関数。
 */

import {
  buildCompanySessionCapRow,
  countActiveSessionsByCompany,
  decideCompanySessionCap,
  type CompanySessionCapDecision,
  type CompanySessionCapRow,
} from "./company-session-cap.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SubsidiaryRepo } from "../db/subsidiary-repo.js";

export const HEAD_OFFICE_NAME = "本社";

export interface CompanySessionCapDeps {
  /** status = 'active' のセッション。 */
  listActiveSessions: () => ReadonlyArray<{ metadata: string | null }>;
  /** 本社の上限 (0 = 上限なし)。 */
  headOfficeMax: () => number;
  /** 子会社と各社の上限 (0 = 上限なし)。 */
  listSubsidiaries: () => ReadonlyArray<{ id: string; name: string; max_sessions: number }>;
}

export class CompanySessionCaps {
  constructor(private readonly deps: CompanySessionCapDeps) {}

  /** 本社を先頭に、 子会社を登録順に並べた稼働数と上限。 */
  report(): CompanySessionCapRow[] {
    const counts = countActiveSessionsByCompany(this.deps.listActiveSessions());
    return [
      buildCompanySessionCapRow({
        subsidiaryId: null,
        name: HEAD_OFFICE_NAME,
        active: counts.get(null) ?? 0,
        max: this.deps.headOfficeMax(),
      }),
      ...this.deps.listSubsidiaries().map((sub) => buildCompanySessionCapRow({
        subsidiaryId: sub.id,
        name: sub.name,
        active: counts.get(sub.id) ?? 0,
        max: sub.max_sessions,
      })),
    ];
  }

  /** その会社でもう 1 本起動してよいか。 登録の無い子会社 id は上限なしとして扱う。 */
  check(subsidiaryId: string | null): CompanySessionCapDecision {
    const row = this.report().find((entry) => entry.subsidiary_id === subsidiaryId);
    return row ? decideCompanySessionCap(row) : { allowed: true };
  }
}

/** 起動の入口とコスト画面が同じ数え方を使うよう、 リポジトリと設定から組み立てる。 */
export function createCompanySessionCaps(input: {
  sessions: Pick<SessionsRepo, "findAllActive">;
  headOfficeMax: () => number;
  subsidiaries?: Pick<SubsidiaryRepo, "list">;
}): CompanySessionCaps {
  return new CompanySessionCaps({
    listActiveSessions: () => input.sessions.findAllActive(),
    headOfficeMax: input.headOfficeMax,
    listSubsidiaries: () => input.subsidiaries?.list()
      .map((sub) => ({ id: sub.id, name: sub.display_name || sub.name, max_sessions: sub.max_sessions })) ?? [],
  });
}
