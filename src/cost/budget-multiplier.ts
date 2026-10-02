/**
 * 月次予算のコスト倍率 (spec/feature/usage-budgets.md §3.1、 2026-10-02 neco 指示
 * 「相談はモデルが固定されているので、 予算消費を本来のコストの 1/4 で考えてください。
 *  ユーザーの属性と部署それぞれにそのようなコスト倍率があります」)。
 *
 * 予算から引く額 = 本来のトークン × 部署の倍率 × 消費する人の属性 (社員名簿の役職) の倍率。
 * 倍率の値はデータ (部署設定・属性の倍率表) が持ち、 ここに部署ごとの固定値は書かない。
 *
 * @implements SPEC-USAGE-BUDGET-MULTIPLIER
 */

import { parseDepartmentSettings } from "../departments/settings.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:18fb1ae6 */
import augurContract_58e014b6 from './budget-multiplier.contract.js'; /* augur-inject:contract-predicate:53121857 */

/** 倍率の既定 (設定が無い・読めないときは本来のコストで数える)。 */
export const DEFAULT_COST_MULTIPLIER = 1;
/** 倍率の上限。 下限は 0 より大きいこと (0 は「数えない」になり予算を素通りさせるため認めない)。 */
export const MAX_COST_MULTIPLIER = 10;

export function isValidCostMultiplier(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_COST_MULTIPLIER;
}

/** 本来のトークンを予算から引く額に換算する。 範囲外の倍率は既定 (1) として扱う。 */
export function chargedTokens(tokens: number, departmentMultiplier: number, roleMultiplier: number): number {
  const base = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return base * normalized(departmentMultiplier) * normalized(roleMultiplier);
}
// @ts-expect-error augur-inject
chargedTokens = contract(chargedTokens, { ...augurContract_58e014b6, contractId: 'budget-C-1', mode: 'observe', sample: 1, where: 'src/cost/budget-multiplier.ts:24', rule: 'contract-wrap', id: '58e014b6' }); /* augur-inject:contract-wrap:58e014b6 */

function normalized(multiplier: number): number {
  return isValidCostMultiplier(multiplier) ? multiplier : DEFAULT_COST_MULTIPLIER;
}

/** 部署設定 (settings_json) の倍率。 部署が無い・設定が壊れていれば既定。 */
export function departmentCostMultiplier(settingsJson: string | null | undefined): number {
  if (!settingsJson) return DEFAULT_COST_MULTIPLIER;
  try {
    return parseDepartmentSettings(settingsJson).budget.cost_multiplier;
  } catch {
    // 壊れた部署設定は部署の起動検証が先に止める。 予算の数え方では本来のコストに倒す。
    return DEFAULT_COST_MULTIPLIER;
  }
}
