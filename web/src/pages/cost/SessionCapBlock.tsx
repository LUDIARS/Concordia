/**
 * Cost 画面の「同時セッション」欄。 会社 (本社 / 子会社) ごとに今動いているセッション数と
 * 上限を並べる (spec/feature/usage-budgets.md §9)。 上限 0 は「上限なし」と出す。
 */
import type { CompanySessionCapRow } from "../../api.js";

export function SessionCapBlock({ companies }: { companies: CompanySessionCapRow[] }) {
  if (companies.length === 0) {
    return <div className="text-subtle text-sm">セッション数を取得できませんでした。</div>;
  }
  return (
    <table className="w-full text-sm border-collapse">
      <tbody>
        {companies.map((company) => (
          <tr key={company.subsidiary_id ?? "head-office"} className="border-t border-border/50">
            <td className="py-1 text-text">
              {company.subsidiary_id === null ? "🏠" : "🏢"} {company.name}
              {company.reached ? " ⚠️ 上限" : ""}
            </td>
            <td className="py-1 text-right text-text">
              {company.active}
              <span className="text-subtle text-xs"> / {company.max > 0 ? company.max : "上限なし"}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
