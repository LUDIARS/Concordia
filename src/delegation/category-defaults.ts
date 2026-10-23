/**
 * 拠点 (federation site) ごとの category 既定値。
 *
 * 拠点ではパートタイマーを既定で動かさず、 気に入ったものだけテンプレ別の site override
 * (`is_active: true`) で足していく (2026-10-23 ユーザ指示「パートの既定値は OFF、
 * プラグイン的に追加して気に入ったものだけ ON」)。 本社 (site ID なし) は従来どおり。
 *
 * @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS
 */
import type { DelegationCategory, DelegationCategoryDefaultRow } from "../db/delegation-repo.js";

/** 拠点で設定が無いときの既定。 載っていない category はテンプレの is_active に従う。 */
export const BUILTIN_SITE_CATEGORY_DEFAULTS: Readonly<Partial<Record<DelegationCategory, boolean>>> = {
  parttimer: false,
};

/**
 * 拠点でその category を既定で動かすか。 null は「既定で制限しない」 (本社・対象外 category)。
 *
 * @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS
 */
export function siteCategoryDefault(
  category: string,
  siteId: string | null,
  rows: readonly DelegationCategoryDefaultRow[],
): boolean | null {
  if (!siteId) return null;
  const row = rows.find((item) => item.scope_kind === "site" && item.scope_key === siteId && item.category === category);
  if (row) return row.is_active === 1;
  return BUILTIN_SITE_CATEGORY_DEFAULTS[category as DelegationCategory] ?? null;
}
