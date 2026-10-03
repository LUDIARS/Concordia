import type { UserMonthlyUsage } from "../../api.js";

// 社員名簿の各人の今月の消費 (spec/feature/usage-budgets.md §6)。 予算の有無・本社 / 子会社に関係なく出す。
// 額は倍率込みのトークン。 共有したセッションは区間ごとに指示の回数で按分した額 (§3.2)。
// チーム予算から引いたぶんがあれば内訳を添える。 予算の割合は隣の予算欄 (UsageBudgetEditor) が出す。

export function UserMonthlyUsageCell({ usage }: { usage: UserMonthlyUsage | null }) {
  const consumed = usage?.consumed_tokens ?? 0;
  const team = usage?.team_tokens ?? 0;
  return (
    <div className="flex flex-col gap-0.5" title="今月の消費 (倍率込みのトークン)">
      <span className="text-sm tabular-nums">{consumed.toLocaleString()}</span>
      {team > 0 && <span className="text-[11px] text-subtle">うちチーム {team.toLocaleString()}</span>}
    </div>
  );
}
