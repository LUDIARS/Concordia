/**
 * 月次予算の属性の倍率を Discord のロールで決める (spec/feature/usage-budgets.md §3.1、 2026-10-03 neco 指示
 * 「特定のロールを持つ人 (新入部員、 メンター) などに 0.5 などの倍率をかける」、 選択「Discord のロール」
 * (複数ロールはいちばん低い倍率))。
 *
 * cost 層は Discord を import しない。 人のロールは bootstrap が差し込む関数 (Discord Bot の guild member) から引き、
 * 数分キャッシュする。 引けなければ 1 に倒す (予算の数え方の不調で倍率を上げない)。
 *
 * @implements SPEC-USAGE-BUDGET-MULTIPLIER
 */

import { DEFAULT_COST_MULTIPLIER, isValidCostMultiplier } from "./budget-multiplier.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:800bbf0e */
import augurContract_722242bd from './budget-role-multiplier.contract.js'; /* augur-inject:contract-predicate:fec5828d */

/** 人のロールのキャッシュ期間 (既定 5 分)。 */
export const DEFAULT_MEMBER_ROLES_CACHE_MS = 5 * 60 * 1000;

/** 持っているロールのうち、 倍率が設定されたロールのいちばん低い倍率。 該当なしは 1。 */
export function lowestRoleMultiplier(roleIds: readonly string[], multipliers: ReadonlyMap<string, number>): number {
  let lowest: number | null = null;
  for (const roleId of roleIds) {
    const multiplier = multipliers.get(roleId);
    if (!isValidCostMultiplier(multiplier)) continue;
    lowest = lowest === null ? multiplier : Math.min(lowest, multiplier);
  }
  return lowest ?? DEFAULT_COST_MULTIPLIER;
}
// @ts-expect-error augur-inject
lowestRoleMultiplier = contract(lowestRoleMultiplier, { ...augurContract_722242bd, contractId: 'budget-role-C-1', mode: 'observe', sample: 1, where: 'src/cost/budget-role-multiplier.ts:18', rule: 'contract-wrap', id: '722242bd' }); /* augur-inject:contract-wrap:722242bd */

export interface RoleMultiplierResolverDeps {
  /** Discord の利用者が持つロール id (Bot が在籍する全 guild の分)。 引けなければ null。 */
  memberRoleIds(userId: string): Promise<readonly string[] | null>;
  /** ロール id → 倍率 (設定された行だけ)。 */
  multipliers(): ReadonlyMap<string, number>;
  now?: () => number;
  cacheTtlMs?: number;
}

/** 人 (Discord の利用者) の属性の倍率を返す。 ロールの照会は人ごとにキャッシュする。 */
export class DiscordRoleMultiplierResolver {
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; roleIds: readonly string[] }>();

  constructor(private readonly deps: RoleMultiplierResolverDeps) {
    this.now = deps.now ?? Date.now;
  }

  async multiplierFor(userId: string | null): Promise<number> {
    if (!userId) return DEFAULT_COST_MULTIPLIER;
    const multipliers = this.deps.multipliers();
    // 倍率が 1 件も無ければ Discord に問い合わせない。
    if (multipliers.size === 0) return DEFAULT_COST_MULTIPLIER;
    const roleIds = await this.roleIdsOf(userId);
    return roleIds ? lowestRoleMultiplier(roleIds, multipliers) : DEFAULT_COST_MULTIPLIER;
  }

  /** 次の照会で引き直させる (倍率やロールを変えたとき)。 */
  invalidate(): void {
    this.cache.clear();
  }

  private async roleIdsOf(userId: string): Promise<readonly string[] | null> {
    const ttl = this.deps.cacheTtlMs ?? DEFAULT_MEMBER_ROLES_CACHE_MS;
    const cached = this.cache.get(userId);
    if (cached && this.now() - cached.at < ttl) return cached.roleIds;
    const roleIds = await this.deps.memberRoleIds(userId).catch(() => null);
    // 引けなかったときはキャッシュしない (Bot の起動待ちなどで 1 に固定しない)。
    if (roleIds) this.cache.set(userId, { at: this.now(), roleIds });
    return roleIds;
  }
}
